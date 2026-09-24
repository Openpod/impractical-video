"use client";

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import * as THREE from "three";

// Ported from the impractical landing page's footer hero. A halftone signal
// field: a grid of ink dots whose size is a slow flowing noise carrying thin
// travelling ripples — footage as raster, rendered in the page's own medium.
// Subtle by design; reads as animated paper texture, not a 3D showpiece.

const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const vertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position, 1.0);
  }
`;

const fragment = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform float uTime;
  uniform vec2 uMouse;
  uniform vec2 uRes;
  uniform float uRadial; // 0 = diagonal flow, 1 = rings expanding from centre
  uniform vec3 uColor;   // ink color — dark on light theme, light on dark theme

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
      u.y
    );
  }

  // one thin travelling wavefront. freq sets band spacing, warpA how much it
  // curves, sp its speed, sd a seed so each system looks distinct. The big
  // power collapses it to a tight line.
  float band(float u, float v, float t, float freq, float warpA, float sp, float sd) {
    float w = noise(vec2(v * 0.5 + sd, t * 0.10)) * warpA
            + noise(vec2(v * 1.7 + sd, t * 0.06)) * warpA * 0.45;
    return pow(0.5 + 0.5 * sin(u * freq + w - t * sp), 30.0);
  }

  void main() {
    vec2 asp = vec2(uRes.x / uRes.y, 1.0);
    vec2 p = vUv * asp;

    // a dense fine grid of small dots
    float cells = 104.0;
    vec2 cell = fract(p * cells) - 0.5;
    vec2 id = floor(p * cells) / cells;

    // u = along travel, v = across the front. In the default flow field
    // everything travels toward the bottom-right; in radial mode u becomes the
    // distance from centre, so the wavefronts are rings expanding outward.
    vec2 ctr = p - vec2(asp.x * 0.5, 0.5);
    float du = p.x - p.y;
    float dv = p.x + p.y;
    float ru = length(ctr) * 3.0;                    // radius → expanding rings
    float rv = (ctr.x * 1.3 + ctr.y * 0.7) * 2.0;    // smooth, seam-free warp axis
    float u = mix(du, ru, uRadial);
    float v = mix(dv, rv, uRadial);
    float n = noise(id * 3.6 + vec2(uTime * 0.07, uTime * 0.04));
    u += n * 0.02; // per-dot jitter breaks the line into discrete dots
    float crest = band(u, v, uTime, 2.4, 4.6, 1.15, 0.0);   // wide lazy curves
    crest = max(crest, band(u, v, uTime, 4.6, 2.0, 1.7, 13.0)); // tighter wiggle
    crest = max(crest, band(u, v, uTime, 7.5, 1.3, 2.3, 31.0)); // fast fine ripple
    float m = 1.0 - smoothstep(0.0, 0.42, distance(vUv * asp, uMouse * asp));

    // dot radius in cell units: a visible floor everywhere, only the thin
    // crest line swells (and never large)
    float r = 0.065 + n * 0.008 + crest * 0.15 + m * 0.04;

    float d = length(cell);
    float aa = 0.01 + fwidth(d);
    float dot_ = 1.0 - smoothstep(r - aa, r + aa, d);

    gl_FragColor = vec4(uColor, dot_ * 0.16);
  }
`;

// Dark dots on a light theme, light dots on a dark theme — unless the caller
// pins an explicit ink color (e.g. white dots on the auth gate's red field).
function inkRgb(explicit?: string): [number, number, number] {
  if (explicit) {
    const color = new THREE.Color(explicit);
    return [color.r, color.g, color.b];
  }
  if (typeof document === "undefined") return [1, 1, 1];
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue("--home-dot-ink")
    .trim();
  const color = new THREE.Color(value || "currentColor");
  return [color.r, color.g, color.b];
}

function Dots({ ink, radial = false }: { ink?: string; radial?: boolean }) {
  const mat = useRef<THREE.ShaderMaterial>(null);
  const { size } = useThree();
  const mouse = useRef(new THREE.Vector2(0.5, 0.6));

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      mouse.current.set(event.clientX / window.innerWidth, 1 - event.clientY / window.innerHeight);
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, []);

  // Keep the ink color in sync with the active theme (data-theme on <html>);
  // an explicit ink is fixed and needs no observer.
  useEffect(() => {
    const apply = () => {
      const [r, g, b] = inkRgb(ink);
      mat.current?.uniforms.uColor.value.set(r, g, b);
    };
    apply();
    if (ink) return;
    const observer = new MutationObserver(apply);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, [ink]);

  useFrame((state) => {
    if (!mat.current) return;
    mat.current.uniforms.uTime.value = state.clock.elapsedTime;
    mat.current.uniforms.uRes.value.set(size.width, size.height);
    (mat.current.uniforms.uMouse.value as THREE.Vector2).lerp(mouse.current, 0.06);
  });

  return (
    <mesh>
      <planeGeometry args={[2, 2]} />
      <shaderMaterial
        ref={mat}
        vertexShader={vertex}
        fragmentShader={fragment}
        transparent
        depthWrite={false}
        uniforms={{
          uTime: { value: 0 },
          uMouse: { value: new THREE.Vector2(0.5, 0.6) },
          uRes: { value: new THREE.Vector2(1, 1) },
          uRadial: { value: radial ? 1 : 0 },
          uColor: { value: new THREE.Vector3(...inkRgb(ink)) },
        }}
      />
    </mesh>
  );
}

export function DotField({
  className = "",
  ink,
  radial = false,
  style,
}: {
  className?: string;
  ink?: string;
  radial?: boolean;
  style?: CSSProperties;
}) {
  const holder = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (prefersReducedMotion()) return;
    const el = holder.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => setActive(entry.isIntersecting), {
      rootMargin: "100px",
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div ref={holder} className={className} style={style} aria-hidden>
      {active ? (
        <Canvas dpr={[1, 1.75]} gl={{ antialias: false, alpha: true }} frameloop="always" resize={{ debounce: 0 }}>
          <Dots ink={ink} radial={radial} />
        </Canvas>
      ) : null}
    </div>
  );
}
