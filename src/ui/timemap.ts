// Maps wall-clock time to media time for a <video>, so audio transcribed from a tab capture
// (timestamped with Date.now()) can be placed on the video timeline even across pauses/seeks.

interface Anchor {
  wall: number;
  media: number;
  playing: boolean;
  rate: number;
}

export class TimeMap {
  private anchors: Anchor[] = [];
  private video: HTMLVideoElement | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly onEvent = () => this.mark();

  attach(video: HTMLVideoElement | null) {
    if (this.video === video) return;
    this.detach();
    this.video = video;
    if (!video) return;
    for (const ev of ['play', 'playing', 'pause', 'seeked', 'seeking', 'ratechange', 'waiting', 'stalled']) video.addEventListener(ev, this.onEvent);
    this.timer = setInterval(() => this.mark(), 1000);
    this.mark();
  }

  detach() {
    if (this.video) for (const ev of ['play', 'playing', 'pause', 'seeked', 'seeking', 'ratechange', 'waiting', 'stalled']) this.video.removeEventListener(ev, this.onEvent);
    clearInterval(this.timer);
    this.video = null;
  }

  mark(now = Date.now()) {
    const v = this.video;
    if (!v) return;
    this.push({ wall: now, media: v.currentTime, playing: !v.paused && !v.seeking && v.readyState > 2, rate: v.playbackRate || 1 });
  }

  push(a: Anchor) {
    this.anchors.push(a);
    const cutoff = a.wall - 15 * 60 * 1000;
    while (this.anchors.length > 2 && this.anchors[0].wall < cutoff) this.anchors.shift();
  }

  /** Media time at a wall-clock instant, or null if unknown. */
  toMedia(wall: number): number | null {
    let a: Anchor | undefined;
    for (let i = this.anchors.length - 1; i >= 0; i--) {
      if (this.anchors[i].wall <= wall) {
        a = this.anchors[i];
        break;
      }
    }
    if (!a) return null;
    return a.playing ? a.media + ((wall - a.wall) / 1000) * a.rate : a.media;
  }
}
