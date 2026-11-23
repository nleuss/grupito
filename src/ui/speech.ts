// Text-to-speech with the browser's voices (offline on most systems).
import { baseLang } from '../shared/languages';

let voices: SpeechSynthesisVoice[] = [];
function loadVoices() {
  try {
    voices = speechSynthesis.getVoices();
  } catch {
    voices = [];
  }
}
if (typeof speechSynthesis !== 'undefined') {
  loadVoices();
  speechSynthesis.addEventListener?.('voiceschanged', loadVoices);
}

export function speak(text: string, lang: string, rate = 0.9): boolean {
  if (typeof speechSynthesis === 'undefined' || !text.trim()) return false;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang;
  u.rate = rate;
  const b = baseLang(lang);
  const voice =
    voices.find((v) => v.lang.toLowerCase() === lang.toLowerCase()) ??
    voices.find((v) => baseLang(v.lang) === b && /google|natural|neural/i.test(v.name)) ??
    voices.find((v) => baseLang(v.lang) === b);
  if (voice) u.voice = voice;
  speechSynthesis.speak(u);
  return true;
}
