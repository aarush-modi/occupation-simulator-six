import * as THREE from 'three';

// Procedural grime: world-space noise dirt, floor-level grime, vertical rust streaks.
const NOISE = /* glsl */ `
varying vec3 vWPos;
float h3(vec3 p){ p = fract(p*0.3183099+.1); p*=17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
float n3(vec3 x){ vec3 i=floor(x); vec3 f=fract(x); f=f*f*(3.0-2.0*f);
  return mix(mix(mix(h3(i+vec3(0,0,0)),h3(i+vec3(1,0,0)),f.x),mix(h3(i+vec3(0,1,0)),h3(i+vec3(1,1,0)),f.x),f.y),
             mix(mix(h3(i+vec3(0,0,1)),h3(i+vec3(1,0,1)),f.x),mix(h3(i+vec3(0,1,1)),h3(i+vec3(1,1,1)),f.x),f.y),f.z); }
float fbm(vec3 p){ float a=.5,s=0.; for(int i=0;i<4;i++){ s+=a*n3(p); p*=2.03; a*=.5;} return s; }
`;

// Surface shader injected into MeshPhysicalMaterial, applied after the normal is known so it can drive
// bump (hammered paint, scratches), edge wear on bevels, grime, rust streaks, and wet patches on floors.
function addGrime(mat, amount, rust, { bump = 0.6, wear = 0.0, wet = 0.0 } = {}) {
  mat.onBeforeCompile = (s) => {
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', '#include <common>\n' + NOISE)
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        {
          vec3 wn = normalize(cross(dFdx(vWPos), dFdy(vWPos)));
          float up = smoothstep(0.6, 0.9, wn.y);
          float vertical = 1.0 - smoothstep(0.3, 0.7, abs(wn.y));
          float g = fbm(vWPos * 1.7);
          float fine = n3(vWPos * 14.0);
          // height field: hammered paint + fine pits + scratch lines
          float scratch = smoothstep(0.92, 1.0, n3(vec3(vWPos.x * 40.0, vWPos.y * 2.0, vWPos.z * 40.0 + vWPos.x * 3.0)));
          float hgt = fbm(vWPos * 6.0) * 0.8 - scratch * 0.5;
          // perturbNormalArb-style bump
          vec3 sx = dFdx(-vViewPosition), sy = dFdy(-vViewPosition);
          vec3 r1 = cross(sy, normal), r2 = cross(normal, sx);
          float det = dot(sx, r1);
          vec3 grad = sign(det) * (dFdx(hgt) * r1 + dFdy(hgt) * r2);
          normal = normalize(abs(det) * normal - grad * ${bump.toFixed(3)} * 0.004);

          // edge wear: high curvature (bevels) shows bare metal through the paint
          float curv = clamp(length(fwidth(vNormal)) * 6.0, 0.0, 1.0);
          float edge = smoothstep(0.25, 0.75, curv + (g - 0.5) * 0.6) * ${wear.toFixed(3)};
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.42, 0.42, 0.40), edge);
          metalnessFactor = mix(metalnessFactor, 0.9, edge);
          roughnessFactor = mix(roughnessFactor, 0.35, edge);

          // grime and rust
          float floorDirt = 1.0 - smoothstep(0.0, 0.9, vWPos.y);
          float streak = smoothstep(0.55, 0.9, n3(vec3(vWPos.x * 6.0, vWPos.y * 0.35, vWPos.z * 6.0))) * vertical;
          float dirt = clamp(g * 0.9 + fine * 0.25 - 0.35 + floorDirt * 0.25, 0.0, 1.0) * ${amount.toFixed(3)};
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.10, 0.095, 0.09), dirt);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.36, 0.16, 0.07), streak * ${rust.toFixed(3)} * (0.5 + g));
          diffuseColor.rgb *= 0.9 + fine * 0.2;
          roughnessFactor = clamp(roughnessFactor + (g - 0.4) * 0.3 * ${amount.toFixed(3)} + scratch * -0.2, 0.04, 1.0);

          // wet patches on horizontal surfaces: darker, glossy, reflect the sun
          float puddle = smoothstep(0.36, 0.26, fbm(vWPos * 0.3 + 3.1)) * up * ${wet.toFixed(3)};
          diffuseColor.rgb *= 1.0 - puddle * 0.45;
          roughnessFactor = mix(roughnessFactor, 0.12, puddle);
        }`
      );
  };
  mat.customProgramCacheKey = () => `grime-${amount}-${rust}-${bump}-${wear}-${wet}`;
  return mat;
}

function m(color, { rough = 0.6, metal = 0.0, grime = 0.5, rust = 0.0, clearcoat = 0, bump, wear, wet, ...rest } = {}) {
  const mat = new THREE.MeshPhysicalMaterial({ color, roughness: rough, metalness: metal, clearcoat, clearcoatRoughness: 0.35, envMapIntensity: 1.1, ...rest });
  return grime > 0 ? addGrime(mat, grime, rust, { bump, wear, wet }) : mat;
}

function glow(color, intensity = 4) {
  const c = new THREE.Color(color).multiplyScalar(intensity);
  return new THREE.MeshBasicMaterial({ color: c, toneMapped: false, fog: false });
}

export const M = {
  yellow: m('#e8a512', { rough: 0.5, metal: 0.2, grime: 0.55, rust: 0.35, clearcoat: 0.5, wear: 0.9 }),
  red: m('#b41f18', { rough: 0.45, metal: 0.2, grime: 0.5, rust: 0.4, clearcoat: 0.5, wear: 0.9 }),
  white: m('#dcd9d1', { rough: 0.45, metal: 0.15, grime: 0.55, rust: 0.45, clearcoat: 0.3, wear: 0.8 }),
  blue: m('#24507f', { rough: 0.45, metal: 0.2, grime: 0.5, rust: 0.3, clearcoat: 0.5, wear: 0.9 }),
  green: m('#3e5a3a', { rough: 0.5, metal: 0.2, grime: 0.55, rust: 0.4, clearcoat: 0.3, wear: 0.8 }),
  orange: m('#d9561a', { rough: 0.45, metal: 0.2, grime: 0.45, rust: 0.3, clearcoat: 0.5, wear: 0.9 }),
  steel: m('#8a8d90', { rough: 0.45, metal: 0.85, grime: 0.55, rust: 0.25 }),
  darkSteel: m('#3c3f42', { rough: 0.45, metal: 0.8, grime: 0.6, rust: 0.4, wear: 0.6 }),
  deck: m('#46484a', { rough: 0.72, metal: 0.5, grime: 0.75, rust: 0.15, bump: 0.8, wet: 0.7 }),
  grating: m('#6f706c', { rough: 0.5, metal: 0.85, grime: 0.7, rust: 0.4, wear: 0.7 }),
  rust: m('#6b3a1e', { rough: 0.9, metal: 0.4, grime: 0.6, rust: 0.9 }),
  chrome: m('#d8dadc', { rough: 0.15, metal: 1.0, grime: 0.15 }),
  pipe: m('#4a4b4d', { rough: 0.3, metal: 0.9, grime: 0.4, rust: 0.2, wear: 0.5 }),
  rubber: m('#1b1b1c', { rough: 0.9, grime: 0.2 }),
  black: m('#141516', { rough: 0.6, metal: 0.3, grime: 0.3 }),
  concrete: m('#77756f', { rough: 0.95, grime: 0.8 }),
  glass: new THREE.MeshPhysicalMaterial({ color: '#9fb7c4', roughness: 0.05, metalness: 0, transmission: 0.0, transparent: true, opacity: 0.35, clearcoat: 1 }),
  coverallOrange: m('#c9561e', { rough: 0.85, grime: 0.35, bump: 2.0, sheen: 0.4, sheenColor: new THREE.Color('#ffb080') }),
  coverallBlue: m('#2d4566', { rough: 0.85, grime: 0.35, bump: 2.0, sheen: 0.4, sheenColor: new THREE.Color('#9ab8ff') }),
  coverallRed: m('#8e2a22', { rough: 0.85, grime: 0.35, bump: 2.0, sheen: 0.4, sheenColor: new THREE.Color('#ff9a8a') }),
  hivis: m('#c8e02a', { rough: 0.7, grime: 0.2, sheen: 0.5, sheenColor: new THREE.Color('#e9ff6b') }),
  skin: m('#a07458', { rough: 0.7, grime: 0 }),
  hatWhite: m('#eeeeea', { rough: 0.35, clearcoat: 0.8, grime: 0.25 }),
  hatYellow: m('#f0c419', { rough: 0.35, clearcoat: 0.8, grime: 0.25 }),
  glove: m('#b48a3c', { rough: 0.9, grime: 0.4 }),
  wood: m('#6d5032', { rough: 0.9, grime: 0.5 }),
  screen: glow('#3fa7ff', 2.2),
  screenGreen: glow('#3cff8a', 2.0),
  lamp: glow('#ffd9a0', 6),
  red_glow: glow('#ff2a1a', 6),
  green_glow: glow('#29ff6a', 3),
  amber_glow: glow('#ffae2a', 4),
  flame: glow('#ff7a1a', 2),
  flameCore: glow('#ffe39a', 3),
  gaugeFace: m('#ecebe4', { rough: 0.4, grime: 0.15 }),
  // interiors
  woodLight: m('#b98c5a', { rough: 0.6, grime: 0.15, bump: 1.2 }),
  woodDark: m('#5a3b24', { rough: 0.55, grime: 0.15, bump: 1.2, clearcoat: 0.3 }),
  tileWhite: m('#e8e6e0', { rough: 0.25, grime: 0.2, clearcoat: 0.6 }),
  tileDark: m('#2c2d30', { rough: 0.3, grime: 0.2, clearcoat: 0.5 }),
  marble: m('#e9e6e1', { rough: 0.15, grime: 0.05, clearcoat: 1 }),
  stainless: m('#c5c8cb', { rough: 0.28, metal: 1.0, grime: 0.15, wear: 0.2 }),
  brass: m('#b58a3c', { rough: 0.3, metal: 1.0, grime: 0.2 }),
  copper: m('#b06a43', { rough: 0.35, metal: 1.0, grime: 0.2 }),
  ceramic: m('#f3f1ec', { rough: 0.15, clearcoat: 1, grime: 0.05 }),
  plasticWhite: m('#efefec', { rough: 0.4, grime: 0.1 }),
  plasticBlack: m('#1f2022', { rough: 0.45, grime: 0.1 }),
  plasticRed: m('#c8302a', { rough: 0.4, grime: 0.1 }),
  plasticBlue: m('#2e64b8', { rough: 0.4, grime: 0.1 }),
  plasticGreen: m('#3c9a4e', { rough: 0.4, grime: 0.1 }),
  plasticYellow: m('#f0c22a', { rough: 0.4, grime: 0.1 }),
  plasticGrey: m('#8d9095', { rough: 0.45, grime: 0.1 }),
  cardboard: m('#b98f5c', { rough: 0.9, grime: 0.2, bump: 1.5 }),
  paper: m('#f2efe6', { rough: 0.9, grime: 0.05 }),
  fabricGrey: m('#6a6d72', { rough: 0.95, grime: 0.1, bump: 2.0, sheen: 0.3 }),
  fabricBlue: m('#34507a', { rough: 0.95, grime: 0.1, bump: 2.0, sheen: 0.3 }),
  fabricRed: m('#8f2f2a', { rough: 0.95, grime: 0.1, bump: 2.0, sheen: 0.3 }),
  leather: m('#3b2a20', { rough: 0.55, grime: 0.1, bump: 1.0, clearcoat: 0.2 }),
  leaf: m('#3f7a34', { rough: 0.6, grime: 0.05 }),
  leafDark: m('#25502a', { rough: 0.6, grime: 0.05 }),
  soil: m('#3a2a1e', { rough: 1.0, grime: 0.3, bump: 2.0 }),
  flowerRed: m('#d0283a', { rough: 0.6, grime: 0 }),
  flowerPink: m('#ee7fa8', { rough: 0.6, grime: 0 }),
  flowerYellow: m('#f2c62e', { rough: 0.6, grime: 0 }),
  flowerWhite: m('#f7f4ee', { rough: 0.6, grime: 0 }),
  flowerPurple: m('#8a4fc0', { rough: 0.6, grime: 0 }),
  coffee: m('#3b2416', { rough: 0.2, grime: 0, clearcoat: 1 }),
  milk: m('#f4efe4', { rough: 0.3, grime: 0 }),
  food: m('#d9a35a', { rough: 0.7, grime: 0 }),
  rubberBlue: m('#2e5d9a', { rough: 0.8, grime: 0.1 }),
  scrubs: m('#4f8f9b', { rough: 0.9, grime: 0.05, bump: 1.5, sheen: 0.3 }),
  labCoat: m('#f1f1ee', { rough: 0.9, grime: 0.05, bump: 1.5 }),
  glassClear: new THREE.MeshPhysicalMaterial({ color: '#dfeef2', roughness: 0.05, transparent: true, opacity: 0.3, clearcoat: 1 }),
  glassAmber: new THREE.MeshPhysicalMaterial({ color: '#b5701f', roughness: 0.05, transparent: true, opacity: 0.6, clearcoat: 1 }),
  liquidBlue: new THREE.MeshPhysicalMaterial({ color: '#3a8ad6', roughness: 0.05, transparent: true, opacity: 0.7, clearcoat: 1 }),
};

export const MATERIAL_KEYS = Object.keys(M);
