'use client';

/**
 * Mapeamento centralizado de ícones do editor.
 *
 * Mantemos um único ponto de import para `lucide-react` para facilitar
 * substituição de ícones e manter consistência visual em todo o editor.
 *
 * Convenção: re-exportamos por nome semântico (Play, Cut, etc.) em vez de
 * importar o nome lucide diretamente nos componentes — assim, trocar
 * `Scissors` por outro ícone só requer mudança aqui.
 */

import {
  // Header
  Save,
  Download as ExportIcon,
  Undo2,
  Redo2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  PanelLeft,
  PanelRight,
  // Media bin / assets
  Upload,
  Search,
  Film,
  Image as ImageIcon,
  Music,
  Plus,
  Minus,
  Trash2,
  Link as LinkIcon,
  GripVertical,
  List,
  // Preview
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Repeat,
  Maximize2,
  Volume2,
  VolumeX,
  Palette,
  // Timeline / tools
  MousePointer2,
  Scissors,
  Hand,
  Magnet,
  ZoomIn,
  ZoomOut,
  Lock,
  Unlock,
  Eye,
  EyeOff,
  Wand2,
  AudioLines,
  // Inspector
  Settings2,
  Sliders,
  Type,
  Layers,
  Move,
  Gauge,
  Copy,
  ClipboardPaste,
  Sparkles,
  // Misc
  AlertCircle,
  CheckCircle2,
  Loader2,
  X,
  RefreshCw,
} from 'lucide-react';

export const EditorIcons = {
  // Header
  Save,
  Export: ExportIcon,
  Undo: Undo2,
  Redo: Redo2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  PanelLeft,
  PanelRight,
  // Media bin
  Upload,
  Search,
  Video: Film,
  Image: ImageIcon,
  Audio: Music,
  Plus,
  Minus,
  Trash: Trash2,
  Link: LinkIcon,
  DragHandle: GripVertical,
  List,
  // Preview / playback
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Loop: Repeat,
  Fullscreen: Maximize2,
  VolumeOn: Volume2,
  VolumeOff: VolumeX,
  Palette,
  // Tools
  Select: MousePointer2,
  Blade: Scissors,
  Hand,
  Snap: Magnet,
  ZoomIn,
  ZoomOut,
  Lock,
  Unlock,
  Eye,
  EyeOff,
  Magic: Wand2,
  AudioWave: AudioLines,
  // Inspector / panels
  Settings: Settings2,
  Sliders,
  Caption: Type,
  Type,
  Layers,
  Transform: Move,
  Speed: Gauge,
  Copy,
  Paste: ClipboardPaste,
  AI: Sparkles,
  // Status
  Error: AlertCircle,
  Success: CheckCircle2,
  Spinner: Loader2,
  Close: X,
  Refresh: RefreshCw,
} as const;

export type EditorIconName = keyof typeof EditorIcons;
