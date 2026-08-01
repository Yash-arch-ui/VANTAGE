import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Suspense, useMemo, useRef, useEffect, useState } from "react";
import * as THREE from "three";

/**
 * Parametric wireframe manifold — "grace through mathematics".
 * Torus-knot-derived vertex cloud rendered as thin additive lines.
 * Reacts to cursor with damped pitch/yaw and fades on scroll.
 */
function Manifold({ scroll }: { scroll: { y: number } }) {
  const group = useRef<THREE.Group>(null);
  const mat = useRef<THREE.LineBasicMaterial>(null);
  const { mouse } = useThree();

  const geometry = useMemo(() => {
    // Sample a torus knot then build a sparse line web between nearby points.
    const knot = new THREE.TorusKnotGeometry(1.1, 0.42, 360, 8, 3, 7);
    const pos = knot.attributes.position as THREE.BufferAttribute;
    const points: THREE.Vector3[] = [];
    for (let i = 0; i < pos.count; i++) {
      points.push(new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)));
    }
    const lineVerts: number[] = [];
    const step = 6;
    for (let i = 0; i < points.length; i += step) {
      const a = points[i];
      const b = points[(i + step) % points.length];
      lineVerts.push(a.x, a.y, a.z, b.x, b.y, b.z);
      // cross-links to create the bloom
      const c = points[(i + 73) % points.length];
      if (a.distanceTo(c) < 1.1) {
        lineVerts.push(a.x, a.y, a.z, c.x, c.y, c.z);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(lineVerts, 3));
    knot.dispose();
    return g;
  }, []);

  // damped rotation
  const target = useRef({ x: 0, y: 0 });
  const current = useRef({ x: 0, y: 0 });

  useFrame((_, dt) => {
    if (!group.current || !mat.current) return;
    target.current.x = mouse.y * 0.12; // pitch ~7deg
    target.current.y = mouse.x * 0.16;
    const k = 1 - Math.pow(0.001, dt); // heavy damping
    current.current.x += (target.current.x - current.current.x) * k;
    current.current.y += (target.current.y - current.current.y) * k;
    group.current.rotation.x = current.current.x;
    group.current.rotation.y = current.current.y + performance.now() * 0.00006;
    group.current.rotation.z = performance.now() * 0.00003;

    const fade = Math.max(0, 1 - scroll.y / 500);
    const s = 0.9 + 0.1 * fade;
    group.current.scale.setScalar(s * 1.55);
    mat.current.opacity = 0.29 * fade;
  });

  return (
    <group ref={group}>
      <lineSegments geometry={geometry}>
        <lineBasicMaterial
          ref={mat}
          color={"#ffffff"}
          transparent
          opacity={0.29}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          linewidth={1}
        />
      </lineSegments>
      {/* faint emerald inner echo */}
      <lineSegments geometry={geometry} scale={[0.62, 0.62, 0.62]}>
        <lineBasicMaterial
          color={"#00ffaa"}
          transparent
          opacity={0.12}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </lineSegments>
    </group>
  );
}

export function ParametricMesh() {
  const [mounted, setMounted] = useState(false);
  const [supported, setSupported] = useState(true);
  const scroll = useRef({ y: 0 });

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    const onScroll = () => {
      scroll.current.y = window.scrollY;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    try {
      const c = document.createElement("canvas");
      const gl = c.getContext("webgl2") || c.getContext("webgl");
      if (!gl) setSupported(false);
    } catch {
      setSupported(false);
    }
  }, []);

  if (!supported || !mounted) return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-0 grid place-items-center" aria-hidden>
      <div
        className="relative h-[min(70vh,640px)] w-[min(140vh,1500px)] max-w-[95vw]"
        style={{
          WebkitMaskImage:
            "radial-gradient(ellipse 55% 60% at center, #000 20%, rgba(0,0,0,0.55) 55%, transparent 85%)",
          maskImage:
            "radial-gradient(ellipse 55% 60% at center, #000 20%, rgba(0,0,0,0.55) 55%, transparent 85%)",
        }}
      >
        <Canvas
          dpr={[1, 1.75]}
          camera={{ position: [0, 0, 4.2], fov: 42 }}
          gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
        >
          <Suspense fallback={null}>
            <Manifold scroll={scroll.current} />
          </Suspense>
        </Canvas>
      </div>
    </div>
  );
}
