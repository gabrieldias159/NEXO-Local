'use client';

/**
 * Editor de `CaptionStyle` (estilo padrão de uma track de legendas, ou
 * estilo de um cue específico).
 *
 * Recebe um `style: CaptionStyle` e callback `onChange(patch)`. O caller
 * decide se o patch é aplicado a um cue específico ou propagado para todos
 * os cues da track.
 *
 * Renderiza preview ao vivo no topo (mesma marcação que a `CaptionsOverlay`,
 * porém em uma caixa fixa de demonstração).
 *
 * Sem dependência de IA / API externa — só CSS + slider/select.
 */

import * as React from 'react';
import type { CaptionStyle } from '@/lib/editor/types';
import { Slider } from '@/components/ui/slider';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { CAPTION_PRESETS } from '@/lib/editor/captions/presets';

const FONT_FAMILIES = ['Inter', 'Arial', 'Roboto', 'Impact', 'Georgia'];

const TRANSFORM_LABELS: Record<'none' | 'uppercase', string> = {
  none: 'Normal',
  uppercase: 'MAIÚSCULAS',
};

const FONT_WEIGHTS: Array<{ value: 400 | 500 | 600 | 700; label: string }> = [
  { value: 400, label: 'Regular' },
  { value: 500, label: 'Médio' },
  { value: 600, label: 'Semibold' },
  { value: 700, label: 'Negrito' },
];

const ALIGN_LABELS: Record<'left' | 'center' | 'right', string> = {
  left: 'Esquerda',
  center: 'Centro',
  right: 'Direita',
};

const POSITION_LABELS: Record<'top' | 'center' | 'bottom', string> = {
  top: 'Topo',
  center: 'Centro',
  bottom: 'Base',
};

interface CaptionStyleEditorProps {
  style: CaptionStyle;
  onChange: (patch: Partial<CaptionStyle>) => void;
  /** Texto de preview (fixed). Default: "Texto de exemplo da legenda". */
  previewText?: string;
  className?: string;
}

export function CaptionStyleEditor({
  style,
  onChange,
  previewText = 'Texto de exemplo da legenda',
  className,
}: CaptionStyleEditorProps) {
  return (
    <div className={cn('flex flex-col gap-3', className)}>
      {/* Preview */}
      <div className="rounded-[var(--editor-radius-sm)] border border-border bg-[hsl(var(--editor-stage))] p-4">
        <div
          className={cn(
            'mx-auto flex min-h-[80px] items-end justify-center',
            style.position === 'top' && 'items-start',
            style.position === 'center' && 'items-center',
            style.position === 'bottom' && 'items-end',
          )}
        >
          <span
            style={{
              fontFamily: style.fontFamily,
              fontSize: `${style.fontSize * 0.5}px`, // 50% para caber no preview
              fontWeight: style.fontWeight,
              color: style.color,
              backgroundColor: style.backgroundColor,
              textAlign: style.align,
              paddingLeft: `${style.paddingX * 0.5}px`,
              paddingRight: `${style.paddingX * 0.5}px`,
              paddingTop: `${style.paddingY * 0.5}px`,
              paddingBottom: `${style.paddingY * 0.5}px`,
              borderRadius: `${style.borderRadius * 0.5}px`,
              display: 'inline-block',
              maxWidth: `${style.maxWidthPct ?? 90}%`,
              lineHeight: style.lineHeight ?? 1.25,
              letterSpacing: style.letterSpacing
                ? `${style.letterSpacing * 0.5}px`
                : undefined,
              textTransform:
                style.textTransform === 'uppercase' ? 'uppercase' : undefined,
              whiteSpace: 'pre-line',
              textShadow:
                style.shadowColor && style.shadowBlur
                  ? `0 0 ${style.shadowBlur * 0.5}px ${style.shadowColor}`
                  : undefined,
              WebkitTextStroke:
                style.outlineColor && style.outlineWidth
                  ? `${style.outlineWidth * 0.5}px ${style.outlineColor}`
                  : undefined,
            }}
          >
            {previewText}
          </span>
        </div>
      </div>

      {/* Presets de estilo (1 clique) */}
      <Section title="Estilos prontos">
        <div className="grid grid-cols-3 gap-1.5">
          {CAPTION_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => onChange(preset.style)}
              className="group flex h-12 items-center justify-center overflow-hidden rounded-[var(--editor-radius-sm)] border border-border bg-[hsl(var(--editor-stage))] transition hover:border-[var(--editor-track-cc)]"
              title={preset.label}
            >
              <span
                style={{
                  fontFamily: preset.style.fontFamily,
                  fontWeight: preset.style.fontWeight,
                  color: preset.style.color,
                  backgroundColor: preset.style.backgroundColor,
                  borderRadius: `${(preset.style.borderRadius ?? 0) * 0.5}px`,
                  padding: '2px 6px',
                  fontSize: '13px',
                  lineHeight: 1.1,
                  textTransform:
                    preset.style.textTransform === 'uppercase'
                      ? 'uppercase'
                      : undefined,
                  textShadow:
                    preset.style.shadowColor && preset.style.shadowBlur
                      ? `0 0 ${(preset.style.shadowBlur ?? 0) * 0.4}px ${preset.style.shadowColor}`
                      : undefined,
                  WebkitTextStroke:
                    preset.style.outlineColor && preset.style.outlineWidth
                      ? `${(preset.style.outlineWidth ?? 0) * 0.35}px ${preset.style.outlineColor}`
                      : undefined,
                }}
              >
                Aa
              </span>
            </button>
          ))}
        </div>
        <p className="text-[9px] text-muted-foreground">
          Clique num estilo pronto e depois ajuste abaixo se quiser.
        </p>
      </Section>

      {/* Tipografia */}
      <Section title="Tipografia">
        <Field label="Família">
          <Select
            value={style.fontFamily}
            onValueChange={(v) => onChange({ fontFamily: v })}
          >
            <SelectTrigger className="h-7 text-[11px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FONT_FAMILIES.map((f) => (
                <SelectItem key={f} value={f} className="text-[11px]">
                  <span style={{ fontFamily: f }}>{f}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field label={`Tamanho · ${style.fontSize}px`}>
          <Slider
            value={[style.fontSize]}
            min={16}
            max={72}
            step={1}
            onValueChange={([v]) => onChange({ fontSize: v })}
          />
        </Field>

        <Field label="Peso">
          <Select
            value={String(style.fontWeight)}
            onValueChange={(v) =>
              onChange({
                fontWeight: parseInt(v, 10) as CaptionStyle['fontWeight'],
              })
            }
          >
            <SelectTrigger className="h-7 text-[11px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FONT_WEIGHTS.map((w) => (
                <SelectItem
                  key={w.value}
                  value={String(w.value)}
                  className="text-[11px]"
                >
                  {w.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field label="Caixa de texto">
          <RadioGroup
            value={style.textTransform ?? 'none'}
            onValueChange={(v) =>
              onChange({ textTransform: v as 'none' | 'uppercase' })
            }
            className="flex gap-2"
          >
            {(['none', 'uppercase'] as const).map((opt) => (
              <div key={opt} className="flex items-center gap-1">
                <RadioGroupItem value={opt} id={`cap-transform-${opt}`} />
                <Label
                  htmlFor={`cap-transform-${opt}`}
                  className="text-[10px] font-normal text-muted-foreground"
                >
                  {TRANSFORM_LABELS[opt]}
                </Label>
              </div>
            ))}
          </RadioGroup>
        </Field>

        <Field label={`Espaço entre letras · ${style.letterSpacing ?? 0}px`}>
          <Slider
            value={[style.letterSpacing ?? 0]}
            min={0}
            max={12}
            step={0.5}
            onValueChange={([v]) => onChange({ letterSpacing: v })}
          />
        </Field>

        <Field
          label={`Altura da linha · ${(style.lineHeight ?? 1.25).toFixed(2)}`}
        >
          <Slider
            value={[style.lineHeight ?? 1.25]}
            min={0.9}
            max={2}
            step={0.05}
            onValueChange={([v]) => onChange({ lineHeight: v })}
          />
        </Field>
      </Section>

      {/* Cor */}
      <Section title="Cores">
        <Field label="Texto">
          <ColorInput
            value={style.color}
            onChange={(v) => onChange({ color: v })}
          />
        </Field>

        <Field label="Fundo (com alpha)">
          <ColorInput
            value={style.backgroundColor}
            onChange={(v) => onChange({ backgroundColor: v })}
            alpha
          />
        </Field>
      </Section>

      {/* Contorno */}
      <Section title="Contorno">
        <Field label={`Espessura · ${style.outlineWidth ?? 0}px`}>
          <Slider
            value={[style.outlineWidth ?? 0]}
            min={0}
            max={12}
            step={0.5}
            onValueChange={([v]) =>
              onChange({
                outlineWidth: v,
                // Define uma cor padrão ao ligar o contorno pela 1ª vez.
                outlineColor:
                  v > 0 && !style.outlineColor ? '#000000' : style.outlineColor,
              })
            }
          />
        </Field>
        <Field label="Cor do contorno">
          <ColorInput
            value={style.outlineColor ?? '#000000'}
            onChange={(v) => onChange({ outlineColor: v })}
          />
        </Field>
      </Section>

      {/* Sombra */}
      <Section title="Sombra">
        <Field label={`Desfoque · ${style.shadowBlur ?? 0}px`}>
          <Slider
            value={[style.shadowBlur ?? 0]}
            min={0}
            max={20}
            step={1}
            onValueChange={([v]) =>
              onChange({
                shadowBlur: v,
                shadowColor:
                  v > 0 && !style.shadowColor ? '#000000' : style.shadowColor,
              })
            }
          />
        </Field>
        <Field label="Cor da sombra">
          <ColorInput
            value={style.shadowColor ?? '#000000'}
            onChange={(v) => onChange({ shadowColor: v })}
            alpha
          />
        </Field>
      </Section>

      {/* Alinhamento + posição */}
      <Section title="Posicionamento">
        <Field label="Alinhamento">
          <RadioGroup
            value={style.align}
            onValueChange={(v) =>
              onChange({ align: v as CaptionStyle['align'] })
            }
            className="flex gap-2"
          >
            {(['left', 'center', 'right'] as const).map((opt) => (
              <div key={opt} className="flex items-center gap-1">
                <RadioGroupItem value={opt} id={`cap-align-${opt}`} />
                <Label
                  htmlFor={`cap-align-${opt}`}
                  className="text-[10px] font-normal text-muted-foreground"
                >
                  {ALIGN_LABELS[opt]}
                </Label>
              </div>
            ))}
          </RadioGroup>
        </Field>

        <Field label="Posição vertical (base)">
          <RadioGroup
            value={style.position}
            onValueChange={(v) =>
              onChange({ position: v as CaptionStyle['position'] })
            }
            className="flex gap-2"
          >
            {(['top', 'center', 'bottom'] as const).map((opt) => (
              <div key={opt} className="flex items-center gap-1">
                <RadioGroupItem value={opt} id={`cap-pos-${opt}`} />
                <Label
                  htmlFor={`cap-pos-${opt}`}
                  className="text-[10px] font-normal text-muted-foreground"
                >
                  {POSITION_LABELS[opt]}
                </Label>
              </div>
            ))}
          </RadioGroup>
        </Field>

        <Field
          label={`Ajuste fino de altura · ${(style.offsetY ?? 0) >= 0 ? '+' : ''}${style.offsetY ?? 0}%`}
        >
          <Slider
            value={[style.offsetY ?? 0]}
            min={-50}
            max={50}
            step={1}
            onValueChange={([v]) => onChange({ offsetY: v })}
          />
          <p className="mt-1 text-[9px] text-muted-foreground">
            Desloca a legenda pra cima (−) ou pra baixo (+) em % da altura
            do palco. Aplicado sobre a posição base.
          </p>
        </Field>
      </Section>

      {/* Padding + radius */}
      <Section title="Caixa">
        <Field label={`Padding X · ${style.paddingX}px`}>
          <Slider
            value={[style.paddingX]}
            min={0}
            max={48}
            step={1}
            onValueChange={([v]) => onChange({ paddingX: v })}
          />
        </Field>

        <Field label={`Padding Y · ${style.paddingY}px`}>
          <Slider
            value={[style.paddingY]}
            min={0}
            max={32}
            step={1}
            onValueChange={([v]) => onChange({ paddingY: v })}
          />
        </Field>

        <Field label={`Cantos · ${style.borderRadius}px`}>
          <Slider
            value={[style.borderRadius]}
            min={0}
            max={24}
            step={1}
            onValueChange={([v]) => onChange({ borderRadius: v })}
          />
        </Field>

        <Field label={`Largura máxima · ${style.maxWidthPct ?? 88}%`}>
          <Slider
            value={[style.maxWidthPct ?? 88]}
            min={20}
            max={100}
            step={1}
            onValueChange={([v]) => onChange({ maxWidthPct: v })}
          />
          <p className="mt-1 text-[9px] text-muted-foreground">
            Largura máxima da caixa em % do palco (controla a quebra de linha).
          </p>
        </Field>
      </Section>
    </div>
  );
}

// ============================================================================
// Sub
// ============================================================================

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 border-t border-border pt-2 first:border-0 first:pt-0">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </p>
      {children}
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label className="text-[10px] text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}

function ColorInput({
  value,
  onChange,
  alpha,
}: {
  value: string;
  onChange: (v: string) => void;
  alpha?: boolean;
}) {
  // O `<input type="color">` nativo só aceita `#rrggbb`. Quando o valor traz
  // alpha (`#rrggbbAA`), separamos: o color picker recebe os 6 primeiros
  // dígitos, e o alpha vai num slider lateral.
  const hex6 = value.length >= 7 ? value.slice(0, 7) : value;
  const alphaHex = alpha && value.length >= 9 ? value.slice(7, 9) : 'FF';
  const alphaNum = parseInt(alphaHex, 16);

  return (
    <div className="flex items-center gap-2">
      <input
        type="color"
        value={hex6}
        onChange={(e) => {
          const newColor = alpha
            ? `${e.target.value}${alphaHex}`
            : e.target.value;
          onChange(newColor);
        }}
        className="h-7 w-10 cursor-pointer rounded-[var(--editor-radius-sm)] border border-border bg-background"
      />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 flex-1 font-mono text-[10px]"
        spellCheck={false}
      />
      {alpha && (
        <div className="flex w-16 flex-col">
          <Slider
            value={[alphaNum]}
            min={0}
            max={255}
            step={1}
            onValueChange={([v]) => {
              const a = v.toString(16).padStart(2, '0').toUpperCase();
              onChange(`${hex6}${a}`);
            }}
          />
          <span className="mt-0.5 text-center text-[9px] text-muted-foreground">
            α {Math.round((alphaNum / 255) * 100)}%
          </span>
        </div>
      )}
    </div>
  );
}
