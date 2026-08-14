'use client';

/**
 * Engines de renderização para chroma key.
 *
 * - `ChromaKeyWebGL`: GPU em tempo real via fragment shader.
 *   Performance: ~60fps mesmo em vídeos 1080p+ em hardware modesto.
 * - `ChromaKeyCanvas2D`: fallback CPU pixel-loop.
 *   Performance: ~15-30fps em 720p, mais lento em resoluções altas.
 *
 * Ambos recebem ref do `<video>` original (que continua tocando oculto)
 * e desenham num canvas overlay.
 */

import { useEffect, useRef } from 'react';
import type { ClipChromaKey } from '@/lib/editor/types';

interface EngineProps {
  videoRef: React.RefObject<HTMLVideoElement>;
  chromaKey: ClipChromaKey;
}

// ----- helpers de hex → rgb ---------------------------------------------------

function hexToRgb01(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  return [r, g, b];
}

// ============================================================================
// WebGL Engine
// ============================================================================

const VERTEX_SRC = `
attribute vec2 a_position;
varying vec2 v_uv;
void main() {
  v_uv = vec2((a_position.x + 1.0) * 0.5, 1.0 - (a_position.y + 1.0) * 0.5);
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const FRAGMENT_SRC = `
precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_image;
uniform vec3 u_keyColor;
uniform float u_similarity;
uniform float u_smoothness;
uniform float u_spill;

void main() {
  vec4 color = texture2D(u_image, v_uv);
  float d = distance(color.rgb, u_keyColor);
  float alpha = smoothstep(u_similarity, u_similarity + max(u_smoothness, 0.001), d);

  vec3 outRgb = color.rgb;
  if (u_spill > 0.0) {
    float maxRB = max(color.r, color.b);
    if (color.g > maxRB) {
      float excess = color.g - maxRB;
      outRgb.g = color.g - excess * u_spill;
    }
  }
  gl_FragColor = vec4(outRgb, color.a * alpha);
}
`;

function compileShader(
  gl: WebGLRenderingContext,
  type: number,
  src: string,
): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error('[chroma webgl] shader compile:', gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function createProgram(gl: WebGLRenderingContext): WebGLProgram | null {
  const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SRC);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SRC);
  if (!vs || !fs) return null;
  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error('[chroma webgl] link:', gl.getProgramInfoLog(program));
    gl.deleteProgram(program);
    return null;
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return program;
}

export function ChromaKeyWebGL({ videoRef, chromaKey }: EngineProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<{
    gl: WebGLRenderingContext;
    program: WebGLProgram;
    texture: WebGLTexture;
    buffer: WebGLBuffer;
    uniforms: {
      keyColor: WebGLUniformLocation | null;
      similarity: WebGLUniformLocation | null;
      smoothness: WebGLUniformLocation | null;
      spill: WebGLUniformLocation | null;
      image: WebGLUniformLocation | null;
    };
  } | null>(null);

  // init WebGL uma vez
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl =
      (canvas.getContext('webgl', { premultipliedAlpha: false, alpha: true }) ||
        canvas.getContext('experimental-webgl', {
          premultipliedAlpha: false,
          alpha: true,
        })) as WebGLRenderingContext | null;
    if (!gl) return;

    const program = createProgram(gl);
    if (!program) return;

    const buffer = gl.createBuffer();
    if (!buffer) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    );
    const pos = gl.getAttribLocation(program, 'a_position');
    gl.enableVertexAttribArray(pos);
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);

    const texture = gl.createTexture();
    if (!texture) return;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

    gl.useProgram(program);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    stateRef.current = {
      gl,
      program,
      texture,
      buffer,
      uniforms: {
        keyColor: gl.getUniformLocation(program, 'u_keyColor'),
        similarity: gl.getUniformLocation(program, 'u_similarity'),
        smoothness: gl.getUniformLocation(program, 'u_smoothness'),
        spill: gl.getUniformLocation(program, 'u_spill'),
        image: gl.getUniformLocation(program, 'u_image'),
      },
    };
    gl.uniform1i(stateRef.current.uniforms.image, 0);

    return () => {
      gl.deleteTexture(texture);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      stateRef.current = null;
    };
  }, []);

  // render loop
  useEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const state = stateRef.current;
    if (!video || !canvas || !state) return;

    const [keyR, keyG, keyB] = hexToRgb01(chromaKey.color);
    let raf = 0;

    const tick = () => {
      if (video.readyState >= 2 && video.videoWidth > 0) {
        const w = video.videoWidth;
        const h = video.videoHeight;
        if (canvas.width !== w) canvas.width = w;
        if (canvas.height !== h) canvas.height = h;
        const { gl, texture, uniforms } = state;
        gl.viewport(0, 0, w, h);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        try {
          gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.RGBA,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            video,
          );
        } catch {
          // CORS-tainted ou frame inválido — pula este frame.
          raf = requestAnimationFrame(tick);
          return;
        }
        gl.uniform3f(uniforms.keyColor, keyR, keyG, keyB);
        gl.uniform1f(uniforms.similarity, chromaKey.similarity);
        gl.uniform1f(uniforms.smoothness, chromaKey.smoothness);
        gl.uniform1f(uniforms.spill, chromaKey.spillSuppression);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [
    videoRef,
    chromaKey.color,
    chromaKey.similarity,
    chromaKey.smoothness,
    chromaKey.spillSuppression,
  ]);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 h-full w-full object-contain"
    />
  );
}

// ============================================================================
// Canvas 2D Engine (fallback)
// ============================================================================

export function ChromaKeyCanvas2D({ videoRef, chromaKey }: EngineProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    const [r01, g01, b01] = hexToRgb01(chromaKey.color);
    const keyR = r01 * 255;
    const keyG = g01 * 255;
    const keyB = b01 * 255;
    const threshold = chromaKey.similarity * 441;
    const smoothBand = Math.max(0.001, chromaKey.smoothness * 441);
    const spill = chromaKey.spillSuppression;

    let raf = 0;
    const tick = () => {
      if (video.readyState >= 2 && video.videoWidth > 0) {
        const maxSide = 1280;
        const ratio = Math.min(
          1,
          maxSide / video.videoWidth,
          maxSide / video.videoHeight,
        );
        const w = Math.max(2, Math.round(video.videoWidth * ratio));
        const h = Math.max(2, Math.round(video.videoHeight * ratio));
        if (canvas.width !== w) canvas.width = w;
        if (canvas.height !== h) canvas.height = h;
        ctx.drawImage(video, 0, 0, w, h);
        const frame = ctx.getImageData(0, 0, w, h);
        const data = frame.data;
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i] ?? 0;
          const g = data[i + 1] ?? 0;
          const b = data[i + 2] ?? 0;
          const dr = r - keyR;
          const dg = g - keyG;
          const db = b - keyB;
          const dist = Math.sqrt(dr * dr + dg * dg + db * db);
          if (dist < threshold) {
            data[i + 3] = 0;
          } else if (dist < threshold + smoothBand) {
            const t = (dist - threshold) / smoothBand;
            data[i + 3] = Math.round((data[i + 3] ?? 255) * t);
          } else if (spill > 0 && g > r && g > b) {
            const excess = g - Math.max(r, b);
            data[i + 1] = Math.max(0, g - excess * spill);
          }
        }
        ctx.putImageData(frame, 0, 0);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [
    videoRef,
    chromaKey.color,
    chromaKey.similarity,
    chromaKey.smoothness,
    chromaKey.spillSuppression,
  ]);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 h-full w-full object-contain"
    />
  );
}
