// Isolated-world content script: wires a site adapter to the subtitle controller and mounts
// the overlay (in a shadow root positioned over the site's <video>).
import { h, render } from 'preact';
import type { Settings, TrackInfo, VideoInfo } from '../shared/types';
import { loadSettings, onSettingsChanged, saveSettings } from '../shared/settings';
import { onVocabChanged } from '../shared/vocab';
import type { ContentStatus, TabMessage } from '../shared/messages';
import { MainBridge } from './bridge';
import { createAdapter, detectSite } from './sites';
import type { SiteAdapter } from './adapters/base';
import { SubtitleController, type PlayerHost } from '../ui/controller';
import { runtimeServices } from '../ui/services';
import { Overlay } from '../ui/overlay';
import { setUiLang } from '../ui/i18n';
import overlayCss from '../ui/overlay.css';

declare global {
  interface Window {
    __vidiomaContent?: boolean;
  }
}

class ContentApp {
  private adapter!: SiteAdapter;
  private ctl!: SubtitleController;
  private settings!: Settings;
  private hostEl: HTMLDivElement | null = null;
  private container: HTMLDivElement | null = null;
  private video: HTMLVideoElement | null = null;
  private videoId: string | null = null;
  private nativeStyle: HTMLStyleElement | null = null;
  private resizeObs: ResizeObserver | null = null;
  private site = detectSite(location);
  private lift = 0;

  constructor(private bridge: MainBridge) {}

  async init() {
    this.settings = await loadSettings();
    setUiLang(this.settings.uiLang);
    const bridge = this.bridge;
    this.adapter = createAdapter(this.site, bridge, { onTracks: (v, t) => this.onTracks(v, t) });

    const host: PlayerHost = {
      getVideo: () => this.video,
      seek: (time) => this.video && this.adapter.seek(this.video, time),
      play: () => this.video && this.adapter.play(this.video),
      pause: () => this.video && this.adapter.pause(this.video),
      suppressed: () => this.adapter.isSuppressed(),
      timeOffset: () => (this.video ? this.adapter.timeOffset(this.video) : 0),
      videoInfo: () => this.adapter.currentVideo(),
      loadTrack: (t) => this.adapter.loadTrack(t),
      loadSiteTranslation: (t, l) => this.adapter.loadSiteTranslation(t, l),
    };
    this.ctl = new SubtitleController(host, runtimeServices, this.settings);
    this.adapter.start();
    this.adapter.observeControls((lift) => {
      this.lift = lift;
      this.hostEl?.style.setProperty('--vd-lift', `${lift}px`);
    });

    onSettingsChanged((s) => {
      this.settings = s;
      setUiLang(s.uiLang);
      this.ctl.updateSettings(s);
      this.poll();
      this.applyNativeHide();
    });
    onVocabChanged(() => this.ctl.refreshSaved());
    this.ctl.store.subscribe(() => this.applyNativeHide());

    chrome.runtime.onMessage.addListener((msg: TabMessage, _sender, sendResponse) => {
      switch (msg.type) {
        case 'cs:status':
          sendResponse(this.status());
          return false;
        case 'cs:aiCues':
          this.ctl.addAiSegments(msg.wallStart, msg.segments);
          return false;
        case 'cs:aiState':
          this.ctl.setAiActive(msg.active, msg.error);
          return false;
        case 'cs:command':
          if (msg.command === 'toggle') this.ctl.toggleHidden();
          if (msg.command === 'transcript') this.ctl.toggleTranscript();
          if (msg.command === 'reload') this.adapter.refresh();
          return false;
      }
      return false;
    });

    window.addEventListener('keydown', (e) => this.onKey(e), true);
    document.addEventListener('mousemove', (e) => this.onMouse(e), { capture: true, passive: true });
    document.addEventListener('fullscreenchange', () => this.reparent());
    window.addEventListener('scroll', () => this.position(), { capture: true, passive: true });
    window.addEventListener('resize', () => this.position(), { passive: true });
    setInterval(() => this.poll(), 700);
    this.poll();
  }

  private enabled(): boolean {
    const s = this.settings;
    if (!s.enabled) return false;
    if (this.site === 'netflix' || this.site === 'youtube') return s.sites[this.site] !== false;
    return true;
  }

  private onTracks(v: VideoInfo, tracks: TrackInfo[]) {
    if (v.id !== this.videoId) return; // e.g. Netflix preloading the next episode
    this.ctl.setTracks(tracks);
  }

  private poll() {
    const info = this.adapter.currentVideo();
    const id = info?.id ?? null;
    if (id !== this.videoId) {
      this.videoId = id;
      this.ctl.reset();
      if (id) this.adapter.refresh();
    }
    const v = this.enabled() && id ? this.adapter.findVideo() : null;
    if (v !== this.video) {
      this.video = v;
      this.resizeObs?.disconnect();
      if (v) {
        this.resizeObs = new ResizeObserver(() => this.position());
        this.resizeObs.observe(v);
      }
    }
    if (v && !this.hostEl) this.mount();
    else if (!v && this.hostEl) this.unmount();
    this.position();
  }

  private mount() {
    const hostEl = document.createElement('div');
    hostEl.id = 'vidioma-overlay';
    hostEl.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483646;pointer-events:none;margin:0;padding:0;border:0;';
    hostEl.style.setProperty('--vd-lift', `${this.lift}px`);
    // Closed in production so pages cannot read the overlay; open in test builds for E2E tests.
    const shadow = hostEl.attachShadow({ mode: __TEST__ ? 'open' : 'closed' });
    const style = document.createElement('style');
    style.textContent = overlayCss;
    const container = document.createElement('div');
    shadow.append(style, container);
    this.hostEl = hostEl;
    this.container = container;
    this.fullscreenParent().appendChild(hostEl);
    render(h(Overlay, { ctl: this.ctl, patchSettings: (p: Partial<Settings>) => void saveSettings(p) }), container);
    this.ctl.start();
    this.position();
  }

  private unmount() {
    if (this.container) render(null, this.container);
    this.hostEl?.remove();
    this.hostEl = this.container = null;
    this.ctl.stop();
    this.applyNativeHide();
  }

  private fullscreenParent(): Element {
    const fs = document.fullscreenElement;
    return fs && !(fs instanceof HTMLVideoElement) ? fs : document.body ?? document.documentElement;
  }

  private reparent() {
    if (!this.hostEl) return;
    const parent = this.fullscreenParent();
    if (this.hostEl.parentElement !== parent) parent.appendChild(this.hostEl);
    this.position();
  }

  private position() {
    const hostEl = this.hostEl;
    const v = this.video;
    if (!hostEl || !v) return;
    const r = v.getBoundingClientRect();
    if (!r.width || !r.height) {
      hostEl.style.display = 'none';
      return;
    }
    // Account for letterboxing so subtitles sit over the picture, not the black bars.
    let { left, top, width, height } = r;
    if (v.videoWidth && v.videoHeight && getComputedStyle(v).objectFit !== 'fill') {
      const scale = Math.min(width / v.videoWidth, height / v.videoHeight);
      const w = v.videoWidth * scale;
      const hh = v.videoHeight * scale;
      left += (width - w) / 2;
      top += (height - hh) / 2;
      width = w;
      height = hh;
    }
    hostEl.style.display = '';
    hostEl.style.left = `${left}px`;
    hostEl.style.top = `${top}px`;
    hostEl.style.width = `${width}px`;
    hostEl.style.height = `${height}px`;
    hostEl.style.setProperty('--vd-h', `${height}px`);
  }

  private applyNativeHide() {
    const want = !!this.hostEl && this.settings.hideNativeSubs && this.ctl.state.cues.length > 0 && !this.ctl.state.hidden && !!this.adapter.hideNativeCss;
    if (want && !this.nativeStyle) {
      this.nativeStyle = document.createElement('style');
      this.nativeStyle.id = 'vidioma-hide-native';
      this.nativeStyle.textContent = this.adapter.hideNativeCss;
      (document.head ?? document.documentElement).appendChild(this.nativeStyle);
    } else if (!want && this.nativeStyle) {
      this.nativeStyle.remove();
      this.nativeStyle = null;
    }
  }

  private onKey(e: KeyboardEvent) {
    if (!this.hostEl || !this.ctl.state.cues.length) return;
    if (this.ctl.handleKey(e, (p) => void saveSettings(p))) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    }
  }

  private onMouse(e: MouseEvent) {
    if (!this.hostEl) return;
    const r = this.hostEl.getBoundingClientRect();
    if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) this.ctl.showControls();
  }

  private status(): ContentStatus {
    const st = this.ctl.state;
    const primary = st.tracks.find((t) => t.id === st.primaryId);
    const tr = st.translationId === 'machine' ? 'machine' : st.translationId === 'site' ? 'site' : st.tracks.find((t) => t.id === st.translationId)?.label;
    return {
      site: this.site,
      active: !!this.hostEl,
      videoTitle: this.adapter.currentVideo()?.title,
      tracks: st.tracks.map((t) => ({ id: t.id, label: t.label, lang: t.lang })),
      primaryLabel: primary?.label,
      translationLabel: tr,
      cueCount: st.cues.length,
      message: st.message,
      aiActive: st.aiActive,
    };
  }
}

if (!window.__vidiomaContent) {
  window.__vidiomaContent = true;
  // Listen to the main world right away (document_start) so no early event is lost.
  const bridge = new MainBridge();
  const start = () => new ContentApp(bridge).init().catch((e) => console.warn('[Vidioma]', e));
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
}
