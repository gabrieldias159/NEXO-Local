/**
 * GET /api/nexo/saude-sistema — SAÚDE DO SISTEMA NEXO.
 *
 * Painel único que agrega:
 *  - Ambiente (emulador vs produção)
 *  - Conectividade dos emuladores Firebase (auth, firestore, storage, functions)
 *  - Conectividade das fontes externas (SICONFI, PNCP, SMARAPD)
 *  - Saúde do Firestore (leitura de coleções chave)
 *  - Frescor dos dados (última coleta por fonte)
 *
 * Uso: consumido pela página /nexo/saude-sistema.
 */
import { NextResponse } from 'next/server';
import { probeSiconfi } from '@/lib/nexo/sources/siconfi';
import { probePncp } from '@/lib/nexo/sources/pncp';
import { probeSmarapd } from '@/lib/nexo/sources/smarapd';
import { MARILIA } from '@/lib/nexo/constants';
import { verificarSessao } from '@/lib/nexo/auth-server';
import { contarColecaoNexo, lerColecaoNexo } from '@/lib/nexo/firestore-read';

export const runtime = 'nodejs';
export const revalidate = 60;

export interface ServicoStatus {
  nome: string;
  ok: boolean;
  detalhe: string | null;
}

export interface SaudeSistemaResponse {
  verificadoEm: string;
  ambiente: {
    emulador: boolean;
    projeto: string;
  };
  servicos: ServicoStatus[];
  fontes: {
    smarapd: { ok: boolean; erro: string | null };
    siconfi: { ok: boolean; erro: string | null };
    pncp: { ok: boolean; erro: string | null };
  };
  colecoes: {
    nome: string;
    documentos: number;
    ultimaAtualizacao: string | null;
  }[];
  observacao: string | null;
}

const COLECOES_MONITORADAS = [
  { nome: 'nexo_despesa_sintetica', campoAtualizacao: '_coletadoEm' },
  { nome: 'nexo_sync_state', campoAtualizacao: 'coletadoEm' },
  { nome: 'nexo_alertas', campoAtualizacao: 'ultimaDeteccaoEm' },
  { nome: 'nexo_contratos_pncp', campoAtualizacao: '_coletadoEm' },
] as const;

async function probePorta(host: string, porta: number, nome: string): Promise<ServicoStatus> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(`http://${host}:${porta}/`, {
      method: 'HEAD',
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    return { nome, ok: true, detalhe: `TCP ${host}:${porta} — HTTP ${res.status}` };
  } catch (err) {
    return {
      nome,
      ok: false,
      detalhe: err instanceof Error ? err.message : 'conexão recusada',
    };
  }
}

export async function GET(req: Request) {
  const sessao = await verificarSessao(req);
  if (!sessao.ok || !sessao.idToken) {
    return NextResponse.json(
      { erro: 'acesso negado ao NEXO' },
      { status: sessao.status, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  const idToken = sessao.idToken;

  const usandoEmulador = process.env.NEXO_USE_EMULATOR === '1';
  const verificadoEm = new Date().toISOString();
  const servicos: ServicoStatus[] = [];
  const colecoes: SaudeSistemaResponse['colecoes'] = [];

  if (usandoEmulador) {
    const [auth, firestore, storage, functions] = await Promise.all([
      probePorta('127.0.0.1', 9099, 'Auth Emulator'),
      probePorta('127.0.0.1', 8080, 'Firestore Emulator'),
      probePorta('127.0.0.1', 9199, 'Storage Emulator'),
      probePorta('127.0.0.1', 5001, 'Functions Emulator'),
    ]);
    servicos.push(auth, firestore, storage, functions);
  } else {
    servicos.push(
      { nome: 'Firebase Auth', ok: true, detalhe: 'produção (nuvem)' },
      { nome: 'Firestore', ok: true, detalhe: 'produção (nuvem)' },
      { nome: 'Storage', ok: true, detalhe: 'produção (nuvem)' },
      { nome: 'Cloud Functions', ok: true, detalhe: 'produção (nuvem)' },
    );
  }

  const [smarapd, siconfi, pncp] = await Promise.all([
    probeSmarapd().catch(() => ({ conectado: false, erro: 'falha na sonda', verificadoEm })),
    probeSiconfi(new Date().getFullYear()).catch(() => ({ conectado: false, erro: 'falha na sonda', verificadoEm })),
    probePncp(MARILIA.cnpjPrefeitura, new Date().getFullYear()).catch(() => ({ conectado: false, erro: 'falha na sonda', verificadoEm })),
  ]);

  for (const cfg of COLECOES_MONITORADAS) {
    try {
      const [documentos, maisRecente] = await Promise.all([
        contarColecaoNexo(cfg.nome, {}, idToken),
        lerColecaoNexo(
          cfg.nome,
          { limit: 1, orderBy: { campo: cfg.campoAtualizacao, direcao: 'desc' } },
          idToken,
          [cfg.campoAtualizacao],
        ),
      ]);
      const ultimaAtualizacao =
        maisRecente.length > 0
          ? String(maisRecente[0][cfg.campoAtualizacao] ?? '') || null
          : null;
      colecoes.push({
        nome: cfg.nome,
        documentos,
        ultimaAtualizacao,
      });
    } catch {
      colecoes.push({ nome: cfg.nome, documentos: -1, ultimaAtualizacao: null });
    }
  }

  const response: SaudeSistemaResponse = {
    verificadoEm,
    ambiente: {
      emulador: usandoEmulador,
      projeto: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? 'studio-8612233125-caa0a',
    },
    servicos,
    fontes: {
      smarapd: { ok: smarapd.conectado, erro: smarapd.erro },
      siconfi: { ok: siconfi.conectado, erro: siconfi.erro },
      pncp: { ok: pncp.conectado, erro: pncp.erro },
    },
    colecoes,
    observacao: usandoEmulador
      ? 'Ambiente local: esta tela prioriza saúde do emulador e leituras leves do banco.'
      : null,
  };

  return NextResponse.json(response, {
    headers: { 'Cache-Control': 'private, max-age=60' },
  });
}
