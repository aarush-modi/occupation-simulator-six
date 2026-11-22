'use client';
import * as THREE from 'three';
import { useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Sky, Environment, Lightformer } from '@react-three/drei';
import { EffectComposer, N8AO, Bloom, ToneMapping, Vignette, Noise, HueSaturation, BrightnessContrast, SMAA, ChromaticAberration } from '@react-three/postprocessing';
import { ToneMappingMode, Effect, BlendFunction } from 'postprocessing';

// Low sun from the player's left-behind: warm key light on everything in view, long shadows.
export const SUN = new THREE.Vector3(-95, 20, 55).normalize();
const HORIZON = new THREE.Color('#e9b07a');

export function Lighting() {
  const sun = useRef();
  const { camera } = useThree();
  useFrame(() => {
    // Shadow frustum follows the player.
    if (!sun.current) return;
    const c = camera.position;
    sun.current.position.set(c.x + SUN.x * 60, SUN.y * 60, c.z + SUN.z * 60);
    sun.current.target.position.set(c.x, 0, c.z);
    sun.current.target.updateMatrixWorld();
  });
  return (
    <>
      <color attach="background" args={['#e2a877']} />
      <fog attach="fog" args={[HORIZON, 120, 900]} />
      <hemisphereLight args={['#b3c8e6', '#3b2c22', 0.45]} />
      {/* cool bounce from the sky side gives teal shadows against the warm key */}
      <directionalLight color="#8fb0d8" intensity={0.3} position={[60, 30, -40]} />
      <directionalLight
        ref={sun}
        color="#ffae63"
        intensity={4.6}
        castShadow
        shadow-mapSize={[4096, 4096]}
        shadow-radius={3}
        shadow-bias={-0.0004}
        shadow-normalBias={0.03}
        shadow-camera-left={-32}
        shadow-camera-right={32}
        shadow-camera-top={32}
        shadow-camera-bottom={-32}
        shadow-camera-near={1}
        shadow-camera-far={160}
      />
      <Sky distance={4500} sunPosition={SUN.clone().multiplyScalar(100).toArray()} turbidity={9} rayleigh={1.6} mieCoefficient={0.006} mieDirectionalG={0.86} />
      <Environment resolution={256} frames={1} environmentIntensity={1.15}>
        <Sky distance={4500} sunPosition={SUN.clone().multiplyScalar(100).toArray()} turbidity={9} rayleigh={1.6} mieCoefficient={0.006} mieDirectionalG={0.86} />
        <Lightformer form="rect" intensity={3} color="#ffb070" position={SUN.clone().multiplyScalar(40).toArray()} scale={[30, 10, 1]} target={[0, 0, 0]} />
        <Lightformer form="rect" intensity={0.6} color="#7fa0c8" position={[0, 40, 0]} rotation-x={Math.PI / 2} scale={[80, 80, 1]} />
      </Environment>
    </>
  );
}

const oceanVert = /* glsl */ `
uniform float uTime;
varying vec3 vW;
varying vec3 vN;
vec3 gerstner(vec2 dir, float steep, float wl, vec3 p, inout vec3 tan, inout vec3 bin) {
  float k = 6.28318 / wl; float c = sqrt(9.8 / k); vec2 d = normalize(dir);
  float f = k * (dot(d, p.xz) - c * uTime); float a = steep / k;
  tan += vec3(-d.x*d.x*(steep*sin(f)), d.x*(steep*cos(f)), -d.x*d.y*(steep*sin(f)));
  bin += vec3(-d.x*d.y*(steep*sin(f)), d.y*(steep*cos(f)), -d.y*d.y*(steep*sin(f)));
  return vec3(d.x*(a*cos(f)), a*sin(f), d.y*(a*cos(f)));
}
void main() {
  vec3 p = (modelMatrix * vec4(position, 1.0)).xyz;
  vec3 tan = vec3(1,0,0), bin = vec3(0,0,1);
  vec3 q = p;
  q += gerstner(vec2(1.0, 0.6), 0.18, 60.0, p, tan, bin);
  q += gerstner(vec2(-0.7, 1.0), 0.14, 31.0, p, tan, bin);
  q += gerstner(vec2(0.2, -1.0), 0.12, 17.0, p, tan, bin);
  q += gerstner(vec2(-1.0, -0.3), 0.08, 9.0, p, tan, bin);
  vN = normalize(cross(bin, tan));
  vW = q;
  gl_Position = projectionMatrix * viewMatrix * vec4(q, 1.0);
}`;

const oceanFrag = /* glsl */ `
uniform vec3 uSun; uniform vec3 uDeep; uniform vec3 uShallow; uniform vec3 uSky; uniform vec3 uHorizon; uniform float uTime;
varying vec3 vW; varying vec3 vN;
float h(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
float n(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f); return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x),f.y); }
void main() {
  vec3 V = normalize(cameraPosition - vW);
  vec2 uv = vW.xz * 0.35;
  vec3 N = normalize(vN + vec3(n(uv + uTime*0.4)-0.5, 0.0, n(uv*1.7 - uTime*0.3)-0.5) * 0.35);
  float fres = pow(1.0 - max(dot(N, V), 0.0), 4.0);
  vec3 col = mix(uDeep, uShallow, clamp(vW.y*0.25 + 0.4, 0.0, 1.0));
  col = mix(col, uSky, fres * 0.85);
  vec3 H = normalize(uSun + V);
  float spec = pow(max(dot(N, H), 0.0), 220.0) * 6.0 + pow(max(dot(N, H), 0.0), 18.0) * 0.25;
  col += vec3(1.0, 0.72, 0.42) * spec;
  float foam = smoothstep(0.9, 1.6, vW.y + n(uv*4.0)*0.6);
  col = mix(col, vec3(0.85, 0.8, 0.72), foam * 0.5);
  float dist = length(cameraPosition.xz - vW.xz);
  col = mix(col, uHorizon, smoothstep(120.0, 900.0, dist));
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

export function Ocean() {
  const mat = useRef();
  const uniforms = useMemo(() => ({
    uTime: { value: 0 },
    uSun: { value: SUN.clone() },
    uDeep: { value: new THREE.Color('#0b2a3a') },
    uShallow: { value: new THREE.Color('#1d5866') },
    uSky: { value: new THREE.Color('#d9a27a') },
    uHorizon: { value: HORIZON.clone() },
  }), []);
  useFrame((_, dt) => { if (mat.current) mat.current.uniforms.uTime.value += dt; });
  return (
    <mesh rotation-x={-Math.PI / 2} position={[0, -38, 0]} frustumCulled={false}>
      <planeGeometry args={[3000, 3000, 300, 300]} />
      <shaderMaterial ref={mat} uniforms={uniforms} vertexShader={oceanVert} fragmentShader={oceanFrag} />
    </mesh>
  );
}

// Teal shadows, warm highlights, lifted blacks: the Vice City grade.
class SplitTone extends Effect {
  constructor() {
    super('SplitTone', /* glsl */ `
      void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
        vec3 c = inputColor.rgb;
        float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
        vec3 shadows = vec3(0.0, 0.03, 0.05);
        vec3 highs = vec3(0.10, 0.05, -0.02);
        c += shadows * (1.0 - smoothstep(0.0, 0.5, l)) + highs * smoothstep(0.45, 1.0, l);
        c = mix(vec3(l), c, 1.12);
        c = c * 0.96 + 0.02;
        outputColor = vec4(clamp(c, 0.0, 1.0), inputColor.a);
      }`, { blendFunction: BlendFunction.NORMAL });
  }
}

export function PostFX({ quality = 'high' }) {
  const lite = quality === 'lite';
  const split = useMemo(() => new SplitTone(), []);
  return (
    <EffectComposer multisampling={0} enableNormalPass={false}>
      {!lite && <N8AO aoRadius={1.4} intensity={2.6} distanceFalloff={0.7} halfRes quality="medium" />}
      {!lite && <Bloom luminanceThreshold={0.95} luminanceSmoothing={0.25} mipmapBlur intensity={0.8} radius={0.75} />}
      <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
      <SMAA />
      <primitive object={split} />
      <HueSaturation saturation={0.14} hue={0.0} />
      <BrightnessContrast brightness={0.0} contrast={0.16} />
      {!lite && <ChromaticAberration offset={[0.0006, 0.0006]} radialModulation modulationOffset={0.35} />}
      <Noise opacity={0.03} premultiply />
      <Vignette offset={0.25} darkness={0.55} />
    </EffectComposer>
  );
}
