'use client';

/**
 * NEXO — DOSSIÊ "TUDO LINKADO" (case file COMPREENSIVO) de uma entidade/documento.
 *
 * Página-destino do entity-chip (clique num CNPJ/CPF → cai aqui): mostra TUDO o
 * que a base do NEXO sabe sobre o documento/nome, cruzando todas as fontes.
 * Consome `GET /api/nexo/dossie/{id}` e apresenta, em seções citáveis:
 * Identificação, Dados cadastrais, Score de risco, Sanções (federal/estadual/
 * leniência/contas irregulares), Sócios/pessoas vinculadas, Doações eleitorais,
 * Vínculos (grafo) e Alertas/indícios — cada item citando a FONTE.
 *
 * O `EntityProvider` envolve a página: qualquer CNPJ/CPF em texto livre vira chip
 * investigável (chips dentro do dossiê também são clicáveis). Disclaimer LGPD
 * proeminente: indício a apurar, NUNCA acusação; doação eleitoral é lícita.
 *
 * O CPF chega na URL apenas como HASH (o número nunca trafega). A exibição do
 * número completo na TELA é decisão do dono (fiscalização interna/LAI) e vem do
 * servidor (recuperado de nexo_entidades), não da URL.
 */
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  FolderOpen,
  ChevronLeft,
  TriangleAlert,
  ShieldAlert,
  ShieldCheck,
  Gavel,
  Network,
  FileSearch,
  Landmark,
  Building2,
  User,
  Users,
  ExternalLink,
  BookOpenCheck,
  Scale,
  CircleDot,
  Printer,
  IdCard,
  Vote,
  HeartHandshake,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EntityProvider, EntityText } from '@/components/nexo/entity-text';
import { nexoFetch } from '@/lib/nexo/client-fetch';
import { CompilarBotao, BadgeAtualizado } from '@/components/nexo/NexoTarefaTracker';
import type {
  DossieResponse,
  DossieIdentificacao,
  DossieCadastrais,
  DossieScore,
  DossieSancoes,
  DossieSancaoItem,
  DossieSocios,
  DossieDoacoes,
  DossieAlertas,
  DossieVinculos,
  DossieFonte,
} from '@/app/api/nexo/dossie/[id]/route';

// ── Utils de formatação ───────────────────────────────────────────────────────

function brl(v: number): string {
  return v.toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    maximumFractionDigits: 0,
  });
}

function fmtData(iso: string | null): string {
  if (!iso) return '—';
  const m = iso.slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

const CLASSE_CLS: Record<string, string> = {
  critico: 'border-red-500/30 bg-red-500/10 text-red-300',
  suspeita: 'border-orange-500/30 bg-orange-500/10 text-orange-300',
  atencao: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  informativo: 'border-slate-500/30 bg-slate-500/10 text-slate-300',
};

const NIVEL_CLS: Record<string, string> = {
  critico: 'border-red-500/40 bg-red-500/15 text-red-200',
  alto: 'border-orange-500/40 bg-orange-500/15 text-orange-200',
  medio: 'border-amber-500/40 bg-amber-500/15 text-amber-200',
  baixo: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200',
};

const ESFERA_CLS: Record<string, string> = {
  federal: 'border-red-500/30 bg-red-500/10 text-red-300',
  estadual: 'border-orange-500/30 bg-orange-500/10 text-orange-300',
  leniencia: 'border-violet-500/30 bg-violet-500/10 text-violet-300',
};

const ESFERA_ROTULO: Record<string, string> = {
  federal: 'Federal',
  estadual: 'Estadual (TCE-SP)',
  leniencia: 'Leniência (CGU)',
};

const ICONE_TIPO: Record<string, typeof Building2> = {
  empresa: Building2,
  pessoa: User,
  orgao: Landmark,
};

const ROTULO_COLECAO: Record<string, string> = {
  nexo_empenhos: 'Empenho',
  nexo_contratos_municipais: 'Contrato',
  nexo_licitacoes: 'Licitação',
  nexo_tce_despesas: 'TCE-SP',
  nexo_diario_dom: 'Diário Oficial',
  nexo_documentos: 'Documento',
};

function rotuloColecao(colecao: string): string {
  return ROTULO_COLECAO[colecao] ?? colecao.replace(/^nexo_/, '');
}

// ── Casca de seção (estilo documento) ─────────────────────────────────────────

function Secao({
  numero,
  titulo,
  icon: Icon,
  acessorio,
  children,
}: {
  numero: number;
  titulo: string;
  icon: typeof FolderOpen;
  acessorio?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card className="border-white/5 bg-nexo-surface">
      <CardHeader className="border-b border-white/5 pb-3">
        <div className="flex items-center gap-2.5">
          <span className="font-mono text-xs text-slate-400">
            {String(numero).padStart(2, '0')}
          </span>
          <Icon className="h-4 w-4 text-amber-400/80" />
          <CardTitle className="text-sm font-semibold uppercase tracking-wide text-slate-200">
            {titulo}
          </CardTitle>
          {acessorio && <div className="ml-auto">{acessorio}</div>}
        </div>
      </CardHeader>
      <CardContent className="pt-4">{children}</CardContent>
    </Card>
  );
}

/** Estado vazio honesto por seção — mostra o `motivo` da rota. */
function VazioSecao({ motivo }: { motivo: string | null }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-dashed border-white/10 bg-nexo-chrome p-3 text-[12px] leading-relaxed text-slate-500">
      <CircleDot className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
      <span>{motivo ?? 'Seção sem dados disponíveis.'}</span>
    </div>
  );
}

function Campo({ rotulo, valor }: { rotulo: string; valor: React.ReactNode }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-slate-400">{rotulo}</p>
      <p className="mt-0.5 text-sm text-slate-200">{valor}</p>
    </div>
  );
}

// ── Seção 1: Identificação ────────────────────────────────────────────────────

function SecaoIdentificacao({ ident }: { ident: DossieIdentificacao }) {
  if (!ident.disponivel) return <VazioSecao motivo={ident.motivo} />;
  const Icone = ident.tipo ? ICONE_TIPO[ident.tipo] ?? Building2 : Building2;
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <Icone className="mt-0.5 h-5 w-5 shrink-0 text-amber-400/80" />
        <div className="min-w-0">
          <p className="text-base font-semibold leading-snug text-slate-100">
            {ident.nome || ident.docExibicao || 'Entidade'}
          </p>
          {(ident.docExibicao || ident.docMascarado) && (
            <p className="font-mono text-xs text-slate-500">
              {/* CNPJ vira chip clicável; CPF exibido completo (decisão do dono),
                  mas o chip de CPF só apareceria via hash — aqui é texto puro. */}
              {ident.cnpj ? (
                <EntityText>{ident.docExibicao ?? ident.cnpj}</EntityText>
              ) : (
                ident.docExibicao ?? ident.docMascarado
              )}
            </p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <Campo rotulo="Tipo" valor={ident.tipo ?? '—'} />
        <Campo rotulo="Total empenhado" valor={brl(ident.totalEmpenhado)} />
        <Campo rotulo="Empenhos" valor={String(ident.nEmpenhos)} />
        <Campo
          rotulo="Contratos"
          valor={`${ident.nContratos} (${ident.contratosAtivos} ativo${ident.contratosAtivos === 1 ? '' : 's'})`}
        />
        <Campo rotulo="Licitações" valor={String(ident.nLicitacoes)} />
        <Campo rotulo="Vínculos no grafo" valor={String(ident.nVinculos)} />
        <Campo rotulo="Primeiro visto" valor={fmtData(ident.primeiroVisto)} />
        <Campo rotulo="Último visto" valor={fmtData(ident.ultimoVisto)} />
        <Campo
          rotulo="Exercícios"
          valor={ident.exercicios.length ? ident.exercicios.join(', ') : '—'}
        />
      </div>

      {ident.flags.length > 0 && (
        <div>
          <p className="mb-1.5 text-[10px] uppercase tracking-wide text-slate-400">
            Sinais do perfil
          </p>
          <div className="flex flex-wrap gap-1.5">
            {ident.flags.map((f) => (
              <span
                key={f}
                className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-slate-400"
              >
                {f}
              </span>
            ))}
          </div>
        </div>
      )}

      {ident.secretarias.length > 0 && (
        <div>
          <p className="mb-1 text-[10px] uppercase tracking-wide text-slate-400">
            Unidades gestoras
          </p>
          <p className="text-xs leading-relaxed text-slate-400">
            {ident.secretarias.join(' · ')}
          </p>
        </div>
      )}

      {ident.objetos.length > 0 && (
        <div>
          <p className="mb-1 text-[10px] uppercase tracking-wide text-slate-400">
            Objetos (contratos/licitações)
          </p>
          <ul className="space-y-1">
            {ident.objetos.slice(0, 12).map((o, i) => (
              <li key={i} className="text-xs leading-relaxed text-slate-400">
                <EntityText>{`• ${o}`}</EntityText>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ── Seção 2: Dados cadastrais (CNPJ) ──────────────────────────────────────────

function SecaoCadastrais({ cadastrais }: { cadastrais: DossieCadastrais }) {
  if (!cadastrais.disponivel) return <VazioSecao motivo={cadastrais.motivo} />;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <Campo rotulo="Razão social" valor={cadastrais.razaoSocial ?? '—'} />
        <Campo rotulo="Nome fantasia" valor={cadastrais.nomeFantasia ?? '—'} />
        <Campo rotulo="Situação" valor={cadastrais.situacaoCadastral ?? '—'} />
        <Campo rotulo="Abertura" valor={fmtData(cadastrais.dataAbertura)} />
        <Campo
          rotulo="Capital social"
          valor={cadastrais.capitalSocial != null ? brl(cadastrais.capitalSocial) : '—'}
        />
        <Campo
          rotulo="UF / Município"
          valor={`${cadastrais.uf ?? '—'} / ${cadastrais.municipio ?? '—'}`}
        />
      </div>
      {(cadastrais.cnaePrincipal || cadastrais.cnaeDescricao) && (
        <div>
          <p className="mb-0.5 text-[10px] uppercase tracking-wide text-slate-400">
            CNAE principal
          </p>
          <p className="text-xs leading-relaxed text-slate-300">
            {cadastrais.cnaePrincipal ? `${cadastrais.cnaePrincipal} — ` : ''}
            {cadastrais.cnaeDescricao ?? '—'}
          </p>
        </div>
      )}
      {cadastrais.socios.length > 0 && (
        <div>
          <p className="mb-1.5 text-[10px] uppercase tracking-wide text-slate-400">
            Quadro societário (cadastro da Receita)
          </p>
          <ul className="space-y-1">
            {cadastrais.socios.map((s, i) => (
              <li key={i} className="flex items-center gap-2 text-xs text-slate-300">
                <User className="h-3 w-3 shrink-0 text-slate-400" />
                <span className="truncate">{s.nome}</span>
                {s.qualificacao && (
                  <span className="ml-auto shrink-0 text-[10px] text-slate-500">
                    {s.qualificacao}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ── Seção 3: Score de risco ───────────────────────────────────────────────────

function SecaoScore({ score }: { score: DossieScore }) {
  if (!score.disponivel) return <VazioSecao motivo={score.motivo} />;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-baseline gap-1.5">
          <span className="font-mono text-3xl font-bold text-slate-100">
            {score.score ?? '—'}
          </span>
          <span className="text-xs text-slate-500">/ 100</span>
        </div>
        {score.nivel && (
          <Badge
            variant="outline"
            className={`text-[11px] uppercase ${NIVEL_CLS[score.nivel] ?? NIVEL_CLS.baixo}`}
          >
            {score.nivel}
          </Badge>
        )}
        {score.nAlertas != null && (
          <span className="text-xs text-slate-500">
            {score.nAlertas} alerta(s) considerado(s)
          </span>
        )}
      </div>

      <div className="space-y-2">
        {score.fatores.map((f) => {
          const pct = f.peso > 0 ? Math.min(100, (f.contribuicao / f.peso) * 100) : 0;
          return (
            <div
              key={f.id}
              className="rounded-md border border-white/5 bg-nexo-chrome p-2.5"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-slate-300">{f.rotulo}</span>
                <span className="font-mono text-[11px] text-amber-300">
                  +{f.contribuicao}{' '}
                  <span className="text-slate-400">/ {f.peso} pts</span>
                </span>
              </div>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/5">
                <div
                  className="h-full rounded-full bg-amber-500/50"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
                {f.evidencia}
              </p>
            </div>
          );
        })}
      </div>

      {score.disclaimer && (
        <p className="text-[10px] leading-relaxed text-slate-400">{score.disclaimer}</p>
      )}
    </div>
  );
}

// ── Seção 4: Sanções ──────────────────────────────────────────────────────────

/** Monta o texto dos cadastros federais presentes (CEIS/CNEP/CEPIM). */
function rotulosCadastrosFederais(itens: DossieSancaoItem[]): string {
  const cadastros = Array.from(
    new Set(
      itens
        .filter((s) => s.esfera === 'federal')
        .map((s) => s.cadastro.toUpperCase()),
    ),
  );
  if (cadastros.length === 0) return 'CEIS/CNEP';
  if (cadastros.length === 1) return cadastros[0];
  const ultimo = cadastros[cadastros.length - 1];
  return cadastros.slice(0, -1).join(', ') + ' e ' + ultimo;
}

function SecaoSancoes({
  sancoes,
  cnpj,
}: {
  sancoes: DossieSancoes;
  cnpj: string | null;
}) {
  const semNada =
    sancoes.itens.length === 0 && sancoes.contasIrregulares.length === 0;
  if (!sancoes.disponivel && semNada) {
    return <VazioSecao motivo={sancoes.motivo} />;
  }
  if (semNada) {
    return (
      <div className="flex items-center gap-3 rounded-md border border-emerald-500/20 bg-emerald-500/5 p-3">
        <ShieldCheck className="h-5 w-5 shrink-0 text-emerald-400" />
        <span className="text-sm text-slate-300">
          Nada consta nas fontes consultadas (CEIS/CNEP/CEPIM, TCE-SP, leniência,
          contas irregulares). Indício de regularidade — não garantia; fontes
          podem estar em recoleta.
        </span>
      </div>
    );
  }

  const cadastrosFederais = rotulosCadastrosFederais(sancoes.itens);
  const urlTransparencia = cnpj
    ? `https://portaldatransparencia.gov.br/sancoes/consulta?cpfCnpj=${cnpj}`
    : null;

  // Monta lista de outros cadastros além de CEIS/CNEP (ex.: CEPIM, leniência, estaduais)
  const temCepim = sancoes.itens.some(
    (s) => s.esfera === 'federal' && s.cadastro.toUpperCase().includes('CEPIM'),
  );
  const extras: string[] = [];
  if (temCepim) extras.push('CEPIM');
  if (sancoes.nLeniencia > 0) extras.push('leniência (CGU)');
  if (sancoes.nEstadual > 0) extras.push('cadastro estadual (TCE-SP)');

  return (
    <div className="space-y-3">
      {/* ── Callout CRÍTICO quando há sanção federal (CEIS/CNEP) ────────────── */}
      {sancoes.nFederal > 0 && (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 p-3">
          <div className="mb-1.5 flex flex-wrap items-center gap-2">
            <ShieldAlert className="h-4 w-4 shrink-0 text-red-400" />
            <span className="text-[11px] font-bold uppercase tracking-wide text-red-300">
              Crítico — Inidoneidade Federal
            </span>
            {urlTransparencia && (
              <a
                href={urlTransparencia}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-auto inline-flex items-center gap-1 text-[11px] font-medium text-red-300/80 underline decoration-red-500/30 decoration-dotted underline-offset-2 transition-colors hover:text-red-200"
              >
                <ExternalLink className="h-3 w-3" />
                Ver no Portal da Transparência
              </a>
            )}
          </div>
          <p className="text-sm font-semibold leading-snug text-red-200">
            Consta em {cadastrosFederais} — impedida de contratar com a
            administração pública. Pagamento a empresa inidonea é irregularidade
            grave.
            {extras.length > 0 && (
              <span className="font-normal text-red-300/80">
                {' '}Consta também em: {extras.join(', ')}.
              </span>
            )}
          </p>
          <p className="mt-1.5 text-[11px] leading-relaxed text-red-300/70">
            Indício a apurar — verifique abrangência exata (matriz/filiais) e
            eventual suspensão judicial da sanção antes de qualquer conclusão.
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        {sancoes.nFederal > 0 && (
          <Badge variant="outline" className={`text-[10px] uppercase ${ESFERA_CLS.federal}`}>
            {sancoes.nFederal} federal
          </Badge>
        )}
        {sancoes.nEstadual > 0 && (
          <Badge variant="outline" className={`text-[10px] uppercase ${ESFERA_CLS.estadual}`}>
            {sancoes.nEstadual} estadual
          </Badge>
        )}
        {sancoes.nLeniencia > 0 && (
          <Badge variant="outline" className={`text-[10px] uppercase ${ESFERA_CLS.leniencia}`}>
            {sancoes.nLeniencia} leniência
          </Badge>
        )}
        {sancoes.porRaiz && (
          <span className="text-[10px] text-slate-400">
            (casamento por raiz do CNPJ — confira a filial exata)
          </span>
        )}
      </div>

      {sancoes.itens.length > 0 && (
        <ul className="space-y-2">
          {sancoes.itens.map((s, i) => (
            <li
              key={`${s.cadastro}-${i}`}
              className="rounded-md border border-white/5 bg-nexo-chrome p-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  variant="outline"
                  className={`text-[10px] uppercase ${ESFERA_CLS[s.esfera] ?? ESFERA_CLS.federal}`}
                >
                  {ESFERA_ROTULO[s.esfera] ?? s.esfera}
                </Badge>
                <Badge
                  variant="outline"
                  className="border-white/10 font-mono text-[10px] text-slate-400"
                >
                  {s.cadastro}
                </Badge>
                {s.situacao && (
                  <Badge variant="outline" className="border-white/10 text-[10px] text-slate-400">
                    {s.situacao}
                  </Badge>
                )}
                {/* Link de fonte: federal → Portal da Transparência; outros → sem link */}
                {s.esfera === 'federal' && urlTransparencia && (
                  <a
                    href={urlTransparencia}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ml-auto inline-flex items-center gap-1 text-[10px] text-amber-400/70 underline decoration-amber-500/20 decoration-dotted underline-offset-2 transition-colors hover:text-amber-300"
                  >
                    <ExternalLink className="h-2.5 w-2.5" />
                    Fonte
                  </a>
                )}
              </div>
              {s.tipoSancao && (
                <p className="mt-1.5 text-sm font-medium leading-snug text-slate-200">
                  <EntityText>{s.tipoSancao}</EntityText>
                </p>
              )}
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-slate-500">
                {s.orgaoSancionador && <span>Órgão: {s.orgaoSancionador}</span>}
                <span>
                  Vigência: {fmtData(s.dataInicio)} — {s.dataFim ? fmtData(s.dataFim) : 'em aberto'}
                </span>
              </div>
              {s.fundamentacao && (
                <p className="mt-1 flex items-start gap-1 text-[11px] text-slate-500">
                  <Scale className="mt-0.5 h-3 w-3 shrink-0 text-slate-400" />
                  <span className="leading-relaxed">{s.fundamentacao}</span>
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      {sancoes.contasIrregulares.length > 0 && (
        <div className="rounded-md border border-amber-500/20 bg-amber-500/5 p-3">
          <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-amber-200">
            <TriangleAlert className="h-3.5 w-3.5" />
            Contas julgadas irregulares (TCE-SP) — casadas por NOME
          </p>
          <p className="mb-2 text-[10px] leading-relaxed text-amber-200/70">
            Vínculo a apurar, casado por homonímia (CPF é anonimizado na fonte).
            NÃO é inelegibilidade (decisão da Justiça Eleitoral) nem improbidade.
          </p>
          <ul className="space-y-1.5">
            {sancoes.contasIrregulares.map((c, i) => (
              <li key={i} className="rounded border border-white/5 bg-nexo-chrome p-2 text-[11px]">
                <p className="text-slate-300">{c.nome}</p>
                <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-slate-500">
                  {c.processoTC && <span>TC {c.processoTC}</span>}
                  {c.exercicio != null && <span>Exerc. {c.exercicio}</span>}
                  {c.origem && <span>{c.origem}</span>}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ── Seção 5: Sócios / pessoas vinculadas ──────────────────────────────────────

function SecaoSocios({ socios }: { socios: DossieSocios }) {
  if (!socios.disponivel || socios.total === 0) {
    return <VazioSecao motivo={socios.motivo} />;
  }
  return (
    <div className="space-y-3">
      <p className="text-[11px] text-slate-500">
        {socios.modo === 'reverse'
          ? 'Grupo econômico da pessoa: CNPJs em que aparece como sócia (grafo societário). Cobertura parcial — vínculo a apurar.'
          : 'Quadro de Sócios e Administradores (QSA) da empresa.'}
      </p>
      <ul className="divide-y divide-white/5">
        {socios.itens.map((s, i) => (
          <li key={`${s.nome}-${i}`} className="flex items-center gap-2 py-2">
            {socios.modo === 'reverse' ? (
              <Building2 className="h-3.5 w-3.5 shrink-0 text-slate-500" />
            ) : (
              <User className="h-3.5 w-3.5 shrink-0 text-slate-500" />
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs text-slate-300">
                {s.cnpjVinculado ? (
                  <Link
                    href={`/nexo/dossie/${s.cnpjVinculado}`}
                    className="text-amber-300 underline decoration-amber-500/30 decoration-dotted underline-offset-2 hover:text-amber-200"
                  >
                    {s.nome}
                  </Link>
                ) : (
                  s.nome
                )}
              </p>
              {s.cpfMasc && (
                <p className="font-mono text-[10px] text-slate-400">{s.cpfMasc}</p>
              )}
            </div>
            {s.qualificacao && (
              <span className="shrink-0 text-[10px] text-slate-500">{s.qualificacao}</span>
            )}
          </li>
        ))}
      </ul>
      {socios.truncado && (
        <p className="text-[10px] text-slate-400">
          (exibindo os primeiros {socios.itens.length} de {socios.total})
        </p>
      )}
    </div>
  );
}

// ── Seção 6: Doações eleitorais ───────────────────────────────────────────────

function SecaoDoacoes({ doacoes }: { doacoes: DossieDoacoes }) {
  if (!doacoes.disponivel || doacoes.total === 0) {
    return <VazioSecao motivo={doacoes.motivo} />;
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-500/20 bg-amber-500/5 p-2.5">
        <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-amber-400" />
        <p className="text-[11px] leading-relaxed text-amber-200/90">
          Doação de campanha é ato LÍCITO e PÚBLICO (Lei 9.504/97). Coincidir como
          doador e fornecedor/sócio NÃO é, por si, ilícito — é vínculo A APURAR,
          jamais acusação.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-xs text-slate-400">
        <span>
          Total doado: <span className="font-mono text-amber-300">{brl(doacoes.valorTotal)}</span>
        </span>
        <span>Anos: {doacoes.anos.join(', ') || '—'}</span>
      </div>
      <ul className="space-y-1.5">
        {doacoes.itens.map((d, i) => (
          <li
            key={i}
            className="flex items-center gap-2 rounded-md border border-white/5 bg-nexo-chrome p-2.5"
          >
            <Vote className="h-3.5 w-3.5 shrink-0 text-slate-500" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs text-slate-300">{d.candidato || 'Candidato não informado'}</p>
              <p className="text-[10px] text-slate-500">
                {[d.cargo, d.partido, d.municipio, String(d.ano)].filter(Boolean).join(' · ')}
              </p>
            </div>
            <span className="shrink-0 font-mono text-xs text-amber-300">{brl(d.valor)}</span>
          </li>
        ))}
      </ul>
      {doacoes.truncado && (
        <p className="text-[10px] text-slate-400">
          (exibindo as primeiras {doacoes.itens.length} de {doacoes.total})
        </p>
      )}
    </div>
  );
}

// ── Seção 7: Vínculos (TUDO LINKADO) ──────────────────────────────────────────

function SecaoVinculos({ vinculos }: { vinculos: DossieVinculos }) {
  if (!vinculos.disponivel || vinculos.total === 0) {
    return <VazioSecao motivo={vinculos.motivo} />;
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {Object.entries(vinculos.porTipo).map(([tipo, n]) => (
          <Badge
            key={tipo}
            variant="outline"
            className="border-white/10 font-mono text-[10px] text-slate-400"
          >
            {tipo}: {n}
          </Badge>
        ))}
        {vinculos.truncado && (
          <span className="text-[10px] text-slate-400">
            (exibindo os primeiros {vinculos.itens.length} de {vinculos.total})
          </span>
        )}
      </div>
      <ul className="divide-y divide-white/5">
        {vinculos.itens.map((v, i) => (
          <li key={`${v.no}-${i}`} className="flex items-center gap-2 py-2">
            <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-slate-400">
              {rotuloColecao(v.colecao)}
            </span>
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-slate-500">
              {v.no}
            </span>
            <span className="shrink-0 font-mono text-[10px] text-slate-400">
              {v.tipo} · {v.confianca}
            </span>
          </li>
        ))}
      </ul>
      <Link
        href="/nexo/grafo"
        className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-400 transition-colors hover:text-amber-300"
      >
        <Network className="h-3.5 w-3.5" />
        Explorar a teia completa no Grafo de Vínculos
      </Link>
    </div>
  );
}

// ── Seção 8: Alertas / indícios ───────────────────────────────────────────────

function SecaoAlertas({ alertas }: { alertas: DossieAlertas }) {
  if (!alertas.disponivel || alertas.total === 0) {
    return <VazioSecao motivo={alertas.motivo} />;
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {(['critico', 'suspeita', 'atencao', 'informativo'] as const).map((c) =>
          alertas.porClassificacao[c] > 0 ? (
            <Badge
              key={c}
              variant="outline"
              className={`text-[10px] uppercase ${CLASSE_CLS[c]}`}
            >
              {alertas.porClassificacao[c]} {c}
            </Badge>
          ) : null,
        )}
      </div>
      <ul className="space-y-2.5">
        {alertas.itens.map((a, i) => (
          <li
            key={`${a.detectorId}-${i}`}
            className="rounded-md border border-white/5 bg-nexo-chrome p-3"
          >
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                variant="outline"
                className={`text-[10px] uppercase ${CLASSE_CLS[a.classificacao]}`}
              >
                {a.classificacao}
              </Badge>
              <Badge
                variant="outline"
                className="border-white/10 font-mono text-[10px] text-slate-400"
              >
                {a.detectorId}
              </Badge>
              {a.status && a.status !== 'aberta' && (
                <Badge
                  variant="outline"
                  className="border-white/10 text-[10px] text-slate-500"
                >
                  {a.status}
                </Badge>
              )}
              {a.valorEnvolvido > 0 && (
                <span className="ml-auto font-mono text-xs text-amber-300">
                  {brl(a.valorEnvolvido)}
                </span>
              )}
            </div>
            <p className="mt-1.5 text-sm font-medium leading-snug text-slate-200">
              {a.titulo}
            </p>
            {a.explicacao && (
              <p className="mt-1 text-xs leading-relaxed text-slate-400">
                <EntityText>{a.explicacao}</EntityText>
              </p>
            )}
            {a.fundamentoLegal.length > 0 && (
              <p className="mt-1.5 flex items-start gap-1 text-[11px] text-slate-500">
                <Scale className="mt-0.5 h-3 w-3 shrink-0 text-slate-400" />
                <span>{a.fundamentoLegal.join(' · ')}</span>
              </p>
            )}
            {a.ultimaDeteccaoEm && (
              <p className="mt-1 text-[10px] text-slate-400">
                Última detecção: {fmtData(a.ultimaDeteccaoEm)}
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Seção: Fontes ─────────────────────────────────────────────────────────────

function SecaoFontes({ fontes }: { fontes: DossieFonte[] }) {
  if (fontes.length === 0) return <VazioSecao motivo="Sem fontes registradas." />;
  return (
    <ul className="space-y-2.5">
      {fontes.map((f, i) => (
        <li key={`${f.colecao}-${i}`} className="flex items-start gap-2.5">
          <BookOpenCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-slate-300">
              {f.secao}
              <span className="ml-2 font-mono text-[10px] text-slate-400">
                {f.colecao}
              </span>
            </p>
            <p className="text-[11px] leading-relaxed text-slate-500">{f.descricao}</p>
            {f.procedencia && f.procedencia.url && (
              <Link
                href={f.procedencia.url}
                className="mt-0.5 inline-flex items-center gap-1 text-[11px] font-medium text-amber-400/90 transition-colors hover:text-amber-300"
              >
                <ExternalLink className="h-3 w-3" />
                {f.procedencia.label}
              </Link>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

// ── Página ─────────────────────────────────────────────────────────────────────

export default function DossiePage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? '';
  const [data, setData] = useState<DossieResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  const reqId = useRef(0);
  useEffect(() => {
    if (!id) return;
    const rid = ++reqId.current;
    setLoading(true);
    setErro(null);
    nexoFetch(`/api/nexo/dossie/${encodeURIComponent(id)}`)
      .then(async (r) => {
        const json = await r.json();
        if (!r.ok) throw new Error(json?.erro || `HTTP ${r.status}`);
        return json as DossieResponse;
      })
      .then((json) => {
        if (rid === reqId.current) setData(json);
      })
      .catch((err) => {
        if (rid === reqId.current) {
          setErro(err instanceof Error ? err.message : 'erro desconhecido');
          setData(null);
        }
      })
      .finally(() => {
        if (rid === reqId.current) setLoading(false);
      });
  }, [id]);

  const ident = data?.identificacao;
  const titulo = loading
    ? 'Carregando dossiê…'
    : ident?.nome || ident?.docExibicao || data?.cnpj || 'Dossiê';

  return (
    <EntityProvider>
      <div className="space-y-6">
        <Link
          href="/nexo/dossies"
          className="inline-flex items-center gap-1 text-xs text-slate-500 transition-colors hover:text-amber-400"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
          Voltar aos Dossiês
        </Link>

        {/* Cabeçalho do case file */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs uppercase tracking-widest text-slate-400">
              <FolderOpen className="h-4 w-4 text-amber-400" />
              Dossiê — Tudo Linkado
            </div>
            <h1 className="mt-1 truncate text-2xl font-bold tracking-tight text-slate-100">
              {titulo}
            </h1>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              {(ident?.docExibicao || ident?.docMascarado) && (
                <span className="font-mono text-sm text-slate-500">
                  {ident.docExibicao ?? ident.docMascarado}
                </span>
              )}
              {data?.score.disponivel && data.score.nivel && (
                <Badge
                  variant="outline"
                  className={`text-[10px] uppercase ${NIVEL_CLS[data.score.nivel] ?? NIVEL_CLS.baixo}`}
                >
                  <Gavel className="mr-1 h-3 w-3" /> risco {data.score.nivel} ({data.score.score})
                </Badge>
              )}
              {data?.sancoes.sancionado && (
                <Badge
                  variant="outline"
                  className="border-red-500/30 bg-red-500/10 text-[10px] uppercase text-red-300"
                >
                  <ShieldAlert className="mr-1 h-3 w-3" /> sancionado
                </Badge>
              )}
              {data && data.doacoes.disponivel && data.doacoes.total > 0 && (
                <Badge
                  variant="outline"
                  className="border-amber-500/30 bg-amber-500/10 text-[10px] uppercase text-amber-300"
                >
                  <Vote className="mr-1 h-3 w-3" /> doador (a apurar)
                </Badge>
              )}
            </div>
          </div>
          <div className="flex shrink-0 flex-col items-stretch gap-2 sm:items-end">
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => typeof window !== 'undefined' && window.print()}
                className="border-white/10 bg-transparent text-slate-300 hover:bg-white/5"
              >
                <Printer className="mr-2 h-4 w-4" />
                Exportar / Imprimir
              </Button>
              {/* Compila o snapshot do dossiê desta entidade em background.
                  Exercício 0 = recorte "todos os anos" (o dossiê é agregado). */}
              {id && (
                <CompilarBotao
                  tipo="dossie"
                  alvo={id}
                  exercicio={0}
                  rotulo={data?.atualizadoEm ? 'Recompilar' : 'Compilar'}
                />
              )}
            </div>
            <BadgeAtualizado geradoEm={data?.atualizadoEm ?? null} />
          </div>
        </div>

        {/* Disclaimer proeminente — indício a apurar, nunca acusação */}
        <div className="flex items-start gap-2.5 rounded-md border border-amber-500/25 bg-amber-500/5 p-3">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
          <p className="text-[12px] leading-relaxed text-amber-200/90">
            <span className="font-semibold">Indício a apurar, nunca acusação.</span>{' '}
            {data?.disclaimer ??
              'Este dossiê reúne e cruza dados públicos já ingeridos. Não é prova ' +
                'de irregularidade. Doação eleitoral é lícita e pública. A apuração ' +
                'cabe a TCE-SP / Ministério Público / Controladoria.'}
          </p>
        </div>

        {loading ? (
          <div className="space-y-3">
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-40 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : erro ? (
          <Card className="border-red-500/20 bg-red-500/5">
            <CardContent className="flex items-start gap-3 py-6 text-sm text-red-300">
              <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0" />
              <div>
                <p className="font-medium">Não foi possível montar o dossiê.</p>
                <p className="mt-1 text-xs text-red-300/80">{erro}</p>
              </div>
            </CardContent>
          </Card>
        ) : data ? (
          <div className="space-y-4">
            <Secao numero={1} titulo="Identificação" icon={Building2}>
              <SecaoIdentificacao ident={data.identificacao} />
            </Secao>

            <Secao numero={2} titulo="Dados cadastrais (Receita)" icon={IdCard}>
              <SecaoCadastrais cadastrais={data.cadastrais} />
            </Secao>

            <Secao
              numero={3}
              titulo="Score de risco"
              icon={Gavel}
              acessorio={
                data.score.disponivel && data.score.nivel ? (
                  <Badge
                    variant="outline"
                    className={`text-[10px] uppercase ${NIVEL_CLS[data.score.nivel] ?? NIVEL_CLS.baixo}`}
                  >
                    {data.score.nivel}
                  </Badge>
                ) : undefined
              }
            >
              <SecaoScore score={data.score} />
            </Secao>

            <Secao
              numero={4}
              titulo="Sanções e impedimentos"
              icon={ShieldAlert}
              acessorio={
                data.sancoes.itens.length > 0 ? (
                  <span className="text-xs text-slate-500">{data.sancoes.itens.length}</span>
                ) : undefined
              }
            >
              <SecaoSancoes sancoes={data.sancoes} cnpj={data.cnpj ?? null} />
            </Secao>

            <Secao
              numero={5}
              titulo="Sócios / pessoas vinculadas"
              icon={Users}
              acessorio={
                data.socios.disponivel && data.socios.total > 0 ? (
                  <span className="text-xs text-slate-500">{data.socios.total}</span>
                ) : undefined
              }
            >
              <SecaoSocios socios={data.socios} />
            </Secao>

            <Secao
              numero={6}
              titulo="Doações eleitorais (TSE)"
              icon={HeartHandshake}
              acessorio={
                data.doacoes.disponivel && data.doacoes.total > 0 ? (
                  <span className="text-xs text-slate-500">{data.doacoes.total}</span>
                ) : undefined
              }
            >
              <SecaoDoacoes doacoes={data.doacoes} />
            </Secao>

            <Secao
              numero={7}
              titulo="Vínculos — TUDO LINKADO"
              icon={Network}
              acessorio={
                data.vinculos.disponivel && data.vinculos.total > 0 ? (
                  <span className="text-xs text-slate-500">{data.vinculos.total}</span>
                ) : undefined
              }
            >
              <SecaoVinculos vinculos={data.vinculos} />
            </Secao>

            <Secao
              numero={8}
              titulo="Alertas / indícios"
              icon={FileSearch}
              acessorio={
                data.alertas.disponivel && data.alertas.total > 0 ? (
                  <span className="text-xs text-slate-500">{data.alertas.total}</span>
                ) : undefined
              }
            >
              <SecaoAlertas alertas={data.alertas} />
            </Secao>

            <Secao numero={9} titulo="Fontes / proveniência" icon={BookOpenCheck}>
              <SecaoFontes fontes={data.fontes} />
            </Secao>

            <p className="px-1 text-[10px] text-slate-400">
              Gerado em {new Date(data.atualizadoEm).toLocaleString('pt-BR')} ·
              interpretação do id como {data.tipoId}
              {data.cnpj ? ` · CNPJ ${data.cnpj}` : ''}.
            </p>
          </div>
        ) : null}
      </div>
    </EntityProvider>
  );
}
