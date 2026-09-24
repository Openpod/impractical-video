import { ArrowUpRight, AudioLines, Check, Clapperboard, KeyRound, Play, Sparkles, Terminal } from "lucide-react";
import styles from "./studio-onboarding.module.css";

function Landscape({ id }: { id: string }) {
  return <svg viewBox="0 0 480 320" fill="none" aria-hidden>
    <defs>
      <linearGradient id={`${id}-sky`} x2="0" y2="320" gradientUnits="userSpaceOnUse"><stop stopColor="#f1f0ed" /><stop offset="1" stopColor="#dddcd7" /></linearGradient>
      <linearGradient id={`${id}-arch`} x1="180" y1="100" x2="300" y2="240" gradientUnits="userSpaceOnUse"><stop stopColor="#ed1d24" /><stop offset="1" stopColor="#be141b" /></linearGradient>
    </defs>
    <path fill={`url(#${id}-sky)`} d="M0 0h480v320H0z" />
    <circle cx="350" cy="86" r="36" fill="#fff" opacity=".75" />
    <path d="M0 226C91 125 180 199 268 210S389 162 480 184V320H0Z" fill="#c5c4be" />
    <path d="M0 266C111 191 188 229 294 234S399 205 480 227V320H0Z" fill="#d8d7d1" />
    <path d="m231 231 99 40 99-7-140-35Z" fill="#a3a29d" opacity=".32" />
    <path d="M189 234V151a56 56 0 0 1 112 0v83h-23v-83a33 33 0 0 0-66 0v83Z" fill="#931017" />
    <path d="M177 230v-83a56 56 0 0 1 112 0v83h-23v-83a33 33 0 0 0-66 0v83Z" fill={`url(#${id}-arch)`} />
    <path d="M0 299c130-31 283-41 480-15v36H0Z" fill="#e1e0da" />
  </svg>;
}

export function StudioArt({ step }: { step: number }) {
  return <div className={styles.art} aria-hidden="true">
    <div className={styles.artStage} key={step}>
      {step === 0 ? <>
        <div className={`${styles.noteCard} ${styles.ideaNote}`}><Sparkles size={15} /><span>A quiet place. An impossible doorway.</span><ArrowUpRight size={14} /></div>
        <div className={styles.filmCard}><div className={styles.filmImage}><Landscape id="welcome" /><span className={styles.frameTag}>SCENE 01</span><span className={styles.play}><Play size={18} fill="currentColor" /></span></div><div className={styles.filmMeta}><span>A world of your own</span><span>00:08</span></div></div>
        <div className={`${styles.noteCard} ${styles.soundNote}`}><AudioLines size={18} /><div className={styles.waveform}>{Array.from({ length: 30 }, (_, i) => <i key={i} style={{ height: `${8 + ((i * 13) % 22)}px` }} />)}</div><span>Soundscape</span></div>
        <div className={styles.floatingLabel}>A thought becomes a scene.</div>
      </> : step === 1 ? <>
        <div className={styles.agentVisual}><div className={styles.agentVisualHead}><Terminal size={16} /><span>YOUR CREATIVE PARTNER</span><span className={styles.connectedDot} /></div><div className={styles.userMessage}>Let the camera drift.<br />Give the scene room to breathe.</div><div className={styles.agentMessage}><Sparkles size={17} /><div>A slower push-in.<br /><span>A little more atmosphere.</span></div></div><div className={styles.agentResult}><Landscape id="agent" /><div><Check size={13} /> Your direction. Every detail.</div></div></div>
        <div className={styles.floatingLabel}>You bring the vision.</div>
      </> : step === 2 ? <>
        <div className={styles.powerVisual}><div className={styles.powerRing} /><div className={styles.powerRingInner} /><div className={styles.powerCore}><KeyRound size={45} strokeWidth={1.25} /></div><div className={`${styles.powerChip} ${styles.chipImage}`}><Sparkles size={20} strokeWidth={1.3} /><span>Images</span></div><div className={`${styles.powerChip} ${styles.chipVideo}`}><Clapperboard size={24} strokeWidth={1.3} /><span>Video</span></div><div className={`${styles.powerChip} ${styles.chipAudio}`}><AudioLines size={20} strokeWidth={1.3} /><span>Audio</span></div></div>
        <div className={styles.floatingLabel}>One connection. Endless directions.</div>
      </> : <>
        <div className={styles.editorVisual}><div className={styles.editorHead}><span>My first film</span><span>CANVAS / EDITOR</span></div><div className={styles.editorPreview}><Landscape id="editor" /><span className={styles.play}><Play size={16} fill="currentColor" /></span></div><div className={styles.timeline}><div className={styles.timeRuler}><span>00:00</span><span>00:04</span><span>00:08</span></div><div className={styles.clipTrack}>{[0, 1, 2, 3, 4].map(i => <div key={i}><Landscape id={`clip-${i}`} /></div>)}</div><div className={styles.audioTrack}>{Array.from({ length: 46 }, (_, i) => <i key={i} style={{ height: `${4 + (i * 7) % 13}px` }} />)}</div><div className={styles.playhead} /></div></div>
        <div className={styles.floatingLabel}>Your next great thing starts small.</div>
      </>}
    </div>
  </div>;
}
