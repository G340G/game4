import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";

export function makePost(renderer, scene, camera) {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  // Low-res nearest look (PS2-ish)
  const lowResPass = new ShaderPass({
    uniforms: {
      tDiffuse: { value: null },
      resolution: { value: new THREE.Vector2(320, 180) }, // will be updated on resize
      time: { value: 0 },
      strength: { value: 0.65 },
      vignette: { value: 0.35 }
    },
    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
    `,
    fragmentShader: /* glsl */`
      uniform sampler2D tDiffuse;
      uniform vec2 resolution;
      uniform float time;
      uniform float strength;
      uniform float vignette;
      varying vec2 vUv;

      float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453123); }

      void main(){
        // pixelate by snapping UV to low-res grid
        vec2 uv = vUv;
        vec2 px = 1.0 / resolution;
        uv = floor(uv / px) * px + px * 0.5;

        // tiny PS2 jitter
        float j = (hash(vec2(floor(time*60.0), uv.y*999.0)) - 0.5) * 0.0009 * strength;
        uv.x += j;

        vec3 col = texture2D(tDiffuse, uv).rgb;

        // grain
        float g = (hash(uv * (resolution.xy + time*13.0)) - 0.5) * 0.10 * strength;
        col += g;

        // vignette
        vec2 p = vUv * 2.0 - 1.0;
        float vig = 1.0 - vignette * dot(p,p);
        col *= clamp(vig, 0.0, 1.0);

        // mild “ps2 contrast”
        col = pow(col, vec3(0.95));
        col = mix(col, col*col*(3.0-2.0*col), 0.22);

        gl_FragColor = vec4(col, 1.0);
      }
    `
  });
  composer.addPass(lowResPass);

  const glitchPass = new ShaderPass({
    uniforms: {
      tDiffuse: { value: null },
      time: { value: 0 },
      glitch: { value: 0.0 } // driven by sanity
    },
    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
    `,
    fragmentShader: /* glsl */`
      uniform sampler2D tDiffuse;
      uniform float time;
      uniform float glitch;
      varying vec2 vUv;

      float hash(float n){ return fract(sin(n)*43758.5453123); }

      void main(){
        vec2 uv = vUv;

        // scanline wobble
        float line = floor(uv.y * 240.0);
        float wob = (hash(line + floor(time*60.0)) - 0.5) * 0.0025 * glitch;
        uv.x += wob;

        // occasional block shift
        float r = hash(floor(time*22.0));
        if(r < glitch*0.12){
          float y0 = hash(floor(time*80.0)) * 0.9;
          float y1 = y0 + 0.08 + glitch*0.12;
          if(uv.y > y0 && uv.y < y1) uv.x += (hash(floor(time*120.0))-0.5)*0.08*glitch;
        }

        vec3 col = texture2D(tDiffuse, uv).rgb;

        // chromatic offset
        float c = 0.0020 * glitch;
        float rch = texture2D(tDiffuse, uv + vec2(c,0.0)).r;
        float bch = texture2D(tDiffuse, uv - vec2(c,0.0)).b;
        col = vec3(rch, col.g, bch);

        gl_FragColor = vec4(col,1.0);
      }
    `
  });
  composer.addPass(glitchPass);

  function onResize(w, h) {
    // keep a consistent low-res feel
    const baseW = 360;
    const aspect = w / h;
    const rw = Math.max(260, Math.floor(baseW));
    const rh = Math.max(180, Math.floor(baseW / aspect));
    lowResPass.uniforms.resolution.value.set(rw, rh);
    composer.setSize(w, h);
  }

  return { composer, lowResPass, glitchPass, onResize };
}
