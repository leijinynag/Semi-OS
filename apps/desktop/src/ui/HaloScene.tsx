import { Canvas, useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { AssistantMode } from "./client-model";
import {
  coreFragmentShader,
  coreVertexShader,
  particleFragmentShader,
  particleVertexShader,
  ribbonFragmentShader,
  ribbonVertexShader,
} from "./halo-shaders";

interface HaloSceneProps {
  mode: AssistantMode;
}

interface HaloMotion {
  pointer: THREE.Vector2;
  reduced: boolean;
}

// 状态只影响能量与流速，不改变构图；这不是语音频谱，真实 TTS 接入后再提供振幅。
const modeEnergy: Record<AssistantMode, readonly [number, number]> = {
  idle: [0.8, 0.65],
  listening: [1, 1],
  working: [1.08, 1.2],
  waiting_confirmation: [0.9, 0.75],
  paused: [0.6, 0.3],
  cancelled: [0.5, 0.25],
};

/** 几何只存参数坐标。曲面、细丝和粒子在 GPU 上使用同一条闭合流线。 */
function makeRibbonGeometry(
  center: number,
  width: number,
  seed: number,
  core: boolean,
) {
  const geometry = new THREE.BufferGeometry();
  const segments = 320;
  const rows = width < 0.01 ? 1 : 16;
  const parameters: number[] = [];
  const seeds: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= segments; i++) {
    for (let j = 0; j <= rows; j++) {
      parameters.push(i / segments, center + (j / rows - 0.5) * width, core ? 1 : 0);
      seeds.push(seed);
      uvs.push(i / segments, j / rows);
      if (i < segments && j < rows) {
        const a = i * (rows + 1) + j;
        const b = a + rows + 1;
        indices.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
  }
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(parameters, 3));
  geometry.setAttribute("aSeed", new THREE.Float32BufferAttribute(seeds, 1));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return geometry;
}

function makeParticleGeometry() {
  const parameters: number[] = [];
  const seeds: number[] = [];
  const sizes: number[] = [];
  let seed = 137;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  for (let i = 0; i < 9200; i++) {
    const core = i < 2300;
    const stream = i % 5;
    // 细流内部聚集、流间留白，避免粒子均匀撒成背景噪点。
    const lane = core
      ? (random() - 0.5) * 0.9
      : (stream - 2) * 0.24 + (random() - 0.5) * 0.13;
    parameters.push(random(), lane, core ? 1 : 0);
    seeds.push(core ? 0 : stream * 1.7);
    sizes.push(0.45 + Math.pow(random(), 5) * 2.6);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(parameters, 3));
  geometry.setAttribute("aSeed", new THREE.Float32BufferAttribute(seeds, 1));
  geometry.setAttribute("aSize", new THREE.Float32BufferAttribute(sizes, 1));
  return geometry;
}

function createUniforms() {
  return {
    uTime: { value: 0 },
    uEnergy: { value: 1 },
    uDpr: { value: 1 },
    uOpacity: { value: 1 },
    uFine: { value: 0 },
  };
}

function createRibbon(
  center: number,
  width: number,
  seed: number,
  core = false,
  fine = false,
) {
  const uniforms = createUniforms();
  uniforms.uFine.value = fine ? 1 : 0;
  uniforms.uOpacity.value = fine ? 0.5 : core ? 0.9 : 0.86;
  return {
    geometry: makeRibbonGeometry(center, width, seed, core),
    material: new THREE.ShaderMaterial({
      uniforms,
      vertexShader: ribbonVertexShader,
      fragmentShader: ribbonFragmentShader,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    }),
  };
}

function FlowSculpture({
  mode,
  motion,
}: {
  mode: AssistantMode;
  motion: HaloMotion;
}) {
  const root = useRef<THREE.Group>(null);
  const animation = useRef({ time: 0, energy: 1, speed: 1 });
  const resources = useMemo(() => {
    const ribbons = [
      createRibbon(-0.22, 0.65, 0),
      createRibbon(0.3, 0.52, 3.4),
      createRibbon(0, 0.65, 0, true),
      createRibbon(0.12, 0.32, 2.2, true),
    ];
    // 细丝不是独立旋转的轨道；与宽光带共享曲面，只有流动的高光相位不同。
    for (let i = 0; i < 26; i++) {
      ribbons.push(createRibbon((i / 25 - 0.5) * 1.2, 0.0025, (i % 5) * 1.7, false, true));
    }
    for (let i = 0; i < 12; i++) {
      ribbons.push(createRibbon((i / 11 - 0.5) * 0.9, 0.003, 0, true, true));
    }
    const particles = {
      geometry: makeParticleGeometry(),
      material: new THREE.ShaderMaterial({
        uniforms: createUniforms(),
        vertexShader: particleVertexShader,
        fragmentShader: particleFragmentShader,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    };
    const core = {
      geometry: new THREE.PlaneGeometry(2.05, 2.05),
      material: new THREE.ShaderMaterial({
        uniforms: createUniforms(),
        vertexShader: coreVertexShader,
        fragmentShader: coreFragmentShader,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    };
    return { ribbons, particles, core, all: [...ribbons, particles, core] };
  }, []);

  useEffect(
    () => () => {
      // 材质和 BufferGeometry 都由此组件创建；预览切换或 HMR 时必须释放 GPU 资源。
      for (const { material, geometry } of resources.all) {
        material.dispose();
        geometry.dispose();
      }
    },
    [resources],
  );

  useFrame((state, delta) => {
    if (!root.current) return;
    const dt = Math.min(delta, 1 / 20);
    const current = animation.current;
    const [energy, speed] = modeEnergy[mode];
    current.energy = motion.reduced ? energy : THREE.MathUtils.damp(current.energy, energy, 3, dt);
    current.speed = THREE.MathUtils.damp(current.speed, speed, 2.5, dt);
    // 积分时间而非 elapsedTime * speed，状态切换和从后台恢复都不会突然跳相位。
    if (!motion.reduced) current.time += dt * current.speed;
    const x = motion.reduced ? 0 : motion.pointer.x;
    const y = motion.reduced ? 0 : motion.pointer.y;
    root.current.rotation.y = motion.reduced ? 0 : THREE.MathUtils.damp(root.current.rotation.y, x * 0.14, 5, dt);
    root.current.rotation.x = motion.reduced ? 0 : THREE.MathUtils.damp(root.current.rotation.x, -y * 0.09, 5, dt);
    root.current.position.x = motion.reduced ? 0 : THREE.MathUtils.damp(root.current.position.x, x * 0.055, 5, dt);
    root.current.position.y = motion.reduced ? 0 : THREE.MathUtils.damp(root.current.position.y, y * 0.035, 5, dt);
    // 固定横向构图并按相机可见范围适配；指针到边缘时仍为光带预留空间。
    root.current.scale.setScalar(Math.min(state.viewport.width / 4.7, state.viewport.height / 3.45));
    for (const { material } of resources.all) {
      material.uniforms.uTime.value = current.time;
      material.uniforms.uEnergy.value = current.energy;
      material.uniforms.uDpr.value = state.gl.getPixelRatio();
    }
  });

  return (
    <group ref={root}>
      <mesh
        geometry={resources.core.geometry}
        material={resources.core.material}
        position={[0, 0, -0.35]}
      />
      {resources.ribbons.map(({ geometry, material }, index) => (
        // 参数坐标不是最终世界坐标，不能用参数空间包围球进行视锥裁剪。
        <mesh key={index} geometry={geometry} material={material} frustumCulled={false} />
      ))}
      <points
        geometry={resources.particles.geometry}
        material={resources.particles.material}
        frustumCulled={false}
      />
    </group>
  );
}

export function HaloScene({ mode }: HaloSceneProps) {
  const pointer = useRef(new THREE.Vector2());
  const [reduced, setReduced] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [visible, setVisible] = useState(() => !document.hidden);
  const motion = useMemo(() => ({ pointer: pointer.current, reduced }), [reduced]);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updateMotion = () => {
      pointer.current.set(0, 0);
      setReduced(media.matches);
    };
    const updateVisibility = () => {
      pointer.current.set(0, 0);
      setVisible(!document.hidden);
    };
    const resetPointer = () => pointer.current.set(0, 0);
    media.addEventListener("change", updateMotion);
    document.addEventListener("visibilitychange", updateVisibility);
    window.addEventListener("blur", resetPointer);
    return () => {
      media.removeEventListener("change", updateMotion);
      document.removeEventListener("visibilitychange", updateVisibility);
      window.removeEventListener("blur", resetPointer);
    };
  }, []);
  return (
    <div
      className="assistant-scene"
      onPointerMove={(event) => {
        if (reduced || event.pointerType === "touch") return;
        // 监听整个画布容器，不依赖 Three 射线命中透明曲面，空白区域也能连续跟随。
        const bounds = event.currentTarget.getBoundingClientRect();
        pointer.current.set(
          THREE.MathUtils.clamp(((event.clientX - bounds.left) / bounds.width - 0.5) * 2, -1, 1),
          THREE.MathUtils.clamp((0.5 - (event.clientY - bounds.top) / bounds.height) * 2, -1, 1),
        );
      }}
      onPointerLeave={() => pointer.current.set(0, 0)}
      onPointerCancel={() => pointer.current.set(0, 0)}
    >
      <Canvas
        camera={{ position: [0, 0, 6], fov: 34 }}
        dpr={[1, 1.75]}
        frameloop={!visible ? "never" : reduced ? "demand" : "always"}
        gl={{ alpha: true, antialias: true, powerPreference: "high-performance" }}
      >
        <FlowSculpture mode={mode} motion={motion} />
      </Canvas>
    </div>
  );
}
