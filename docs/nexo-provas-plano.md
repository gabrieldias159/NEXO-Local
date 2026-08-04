All anchors confirmed. The plan is grounded. Writing the consolidated document now.

---

# NEXO — Camada de Procedência e Visualização de Provas

> **Objetivo do dono:** cada alerta/evidência precisa de um **link clicável para a prova documental** (de onde o dado saiu), o **registro bruto visível**, e o **PDF/página original** quando houver.
>
> **Princípio reitor:** tudo é **aditivo e retrocompatível** (campos opcionais, `default null`). Nenhuma migração de dados; alertas antigos continuam válidos e a UI degrada graciosamente para o comportamento atual (`Ref.: {ref}` em texto). Separamos rigorosamente o **ADITIVO seguro** do **mexe-em-código-que-funciona**.

**Fatos do código que definem a estratégia** (verificados nesta sessão):
- O que é **persistido** em `nexo_alertas` é o corpo do `AlertaDetectado` gravado **verbatim** pela Cloud Function (`functions/src/nexo/deteccao.ts`) — então a `Evidencia` do detector (`src/lib/nexo/detectores/tipos.ts:17-22` = `{resumo, valor?, data?, ref?}`) é o formato **de-facto**. O `evidenciaSchema` (`schemas.ts`) é aspiracional e **não trafega**.
- `Evidencia.ref` hoje é **string crua** = ID do registro bruto. A rota de leitura (`src/app/api/nexo/alertas/route.ts:122-130`) só repassa `{resumo, valor, data, ref}`. A UI (`alerta-detalhe.tsx:290-294`) renderiza `ev.ref` como **texto plano**, nunca como `<Link>`.
- `FONTES` (`constants.ts:27`): `smarapd` = `.../paiportalserver`, `smarapdFiles` = `.../paifileserver`, `pncp` = `pncp.gov.br/api/consulta`. `MARILIA.ibge` = `3529005`.
- **Caveat real:** `ContratoPNCP.id` (`pncp.ts:259-268`) faz `pick` com `numeroControlePncpCompra` **primeiro** → o id costuma ser o controle da **compra** (`-1-`), não do contrato (`-2-`). O builder **deve rotear por tipo** (o dígito do regex).

---

## Receitas de link por fonte

| Fonte | Tipo de objeto | Dá deep-link? | urlTemplate | Prova exibida |
|---|---|:---:|---|---|
| **SMARAPD** `paiportalserver` (SPA) | empenho | Não (módulo) | `{smarapd-SPA}/dinamico/fornecedor/fornecedoranalitico?exercicio={ano}` | Registro bruto `nexo_empenhos` (ID=SMARAPD `ID`) + link de módulo ✔web |
| | despesa | Não (módulo) | `.../dinamico/DespesaAgrupada/DespesaseInvestimentos?exercicio={ano}` | Registro bruto `nexo_despesas` (ID=`IDDespesa`) ✔web |
| | diária | Não (módulo) | `.../dinamico/diarias/diarias?exercicio={ano}` | `nexo_diarias`, **mascarar** ✔web |
| | servidor-folha | Não (módulo) | `.../dinamico/pagamentos/pagamentoaservidores?exercicio={ano}` | `nexo_pagamentos`, **mascarar** ✔web |
| | resto-a-pagar | Não (módulo) | `.../dinamico/restoapagar/restoapagar?exercicio={ano}` | `nexo_restos` ✔web |
| | modalidade | Não (módulo) | `.../dinamico/quadro_de_renda_local/EmpenhoModalidade?exercicio={ano}` | Agregado — link já é a prova ✔web |
| | regra-geral | Não (módulo) | `/dinamico/{ChaveModulo}/{NomeVisao}?exercicio={ano}` (resolver `where(ID==ref) AND _exercicio`) | Registro bruto ✔web |
| **SMARAPD** `paifileserver` (visões fixas) | **pdf-visao-fixa** (LRF / saúde / ensino / FUNDEB / gestão fiscal / balanço) | **SIM (PDF direto)** | `{smarapdFiles}/filemanager/pai/download?nomeArquivo={Arquivo.Url}&isInlineContent=true` | **PDF oficial INLINE** (CORS `*`, sem Content-Disposition → iframe/embed direto). `Arquivo.Url` **verbatim** (já percent-encoded `%2F`/`%C2%BA`). ✔web HTTP 200 `%PDF` |
| | **pdf-portaria-empresa-punida** | **SIM (PDF direto)** | mesmo endpoint acima | **PDF da portaria de sanção INLINE** + registro bruto (empresa, nº portaria) + empenhos pós-sanção. ✔web 200 `%PDF-1.5` |
| **PNCP** `pncp.gov.br` | **contrato** | **SIM (página + PDF)** | `https://pncp.gov.br/app/contratos/{cnpj}/{ano}/{seq}` | Página SPA + registro bruto + **PDF** via `…/api/pncp/v1/orgaos/{cnpj}/contratos/{ano}/{seq}/arquivos` (campo `uri`). ✔web |
| | **edital/contratação** | **SIM (página + PDF)** | `https://pncp.gov.br/app/editais/{cnpj}/{ano}/{seq}` | Página + PDF via `…/compras/{ano}/{seq}/arquivos`. ✔web |
| | **ata de registro de preço** | SIM (formato) — **coleta não existe** | `https://pncp.gov.br/app/atas/{cnpj}/{ano}/{seq}` | PDF via `…/compras/{ano}/{seq}/atas/{seqAta}/arquivos`. ⚠ conector não coleta `/v1/atas` |
| **DOM** (Diário Oficial, interno) | **edicao-dom** | **SIM (interno)** | `/diario-oficial/{ano}/{edicao}` | Página interna (timeline + PDF embutido). `sujeitoId`=`{ano}_{edicao}` ✔web |
| | **pdf-dom** | **SIM (proxy)** | `/api/diario-oficial/edition/{ano}/{edicao}/pdf` | **PDF original INLINE** re-servido (X-Frame SAMEORIGIN) ✔web |
| | **ato-dom / extrato-contrato** | **Parcial** (edição sólida; âncora de ato frágil) | edição: `/diario-oficial/{ano}/{edicao}` — **NÃO** usar `#act-N` (segmentação ≠ UI) | Card do ato + texto + PDF da edição. `sujeitoId`=`{ano}_{edicao}_ato{idx}` ✔web |
| **SICONFI** (API STN) | relatorio-fiscal (RREO/RGF/DCA) | Não (API determinística) | `apidatalake…/tt/{rreo\|rgf\|dca}?an_exercicio={ano}&nr_periodo={p}&id_ente=3529005&no_anexo={enc}` | Registro bruto (conta+coluna+valor) + URL da API (JSON verificável) ✔web |
| | comprovante-de-entrega | Não (API) | `apidatalake…/tt/extrato_entregas?id_ente=3529005&an_referencia={ano}` | Selo "homologado (HO) em {data}" ✔web |
| **TCE-SP** (Portal Transparência Municipal) | **empenho-despesa** | **SIM (página)** quando há `orgaoId`+`emp-ano` | `transparencia.tce.sp.gov.br/municipio/marilia/{ano}/despesas/historico/{orgaoId}/{emp-ano}` | Histórico empenhado/liquidado/pago + registro bruto ✔web |
| | fornecedor-tce | Não (form) | `transparencia.tce.sp.gov.br/despesas-fornecedor` | Agregado por CNPJ + empenhos individuais (cada um com deep-link) ✔web |
| | indicador-saude/educ/pessoal | SIM (página/ano) | `transparencia.tce.sp.gov.br/municipio/marilia/{ano}/despesas` | Cross-check independente do SICONFI ✔web |
| | processo/julgado/apontamento | **Não** (login CAS/Bearer) | — | **Retorna null** — manter estado honesto (`pendente`); nunca inventar URL ✔web |
| **Portal Marília** (SiGoverno) | **contrato** | **SIM** ({id} interno via scraping) | `www.marilia.sp.gov.br/portal/contrato/{id}` | Página de detalhe + PDF. `{id}` **não derivável** dos nossos campos ✔web |
| | **pdf-contrato** | **SIM** ({token} opaco) | `…/portal/download/contratos/{token}/` | **PDF assinado INLINE** ✔web |
| | **pdf-aditivo** | **SIM** ({token} por aditivo) | `…/portal/download/contratos-aditivos/{token}/` | **PDF do aditivo** (prova p/ LC-19/LC-20) ✔web |
| | **edital-licitacao** | **SIM** ({id} interno) | `…/portal/editais/0/1/{id}/` | Página + edital. Contrato linka edital de origem ✔web |
| | pdf-edital | SIM (URL) / não-inline (ZIP) | `…/portal/download/licitacoes/{token}/` | Download (ZIP ~6-7MB) — botão "baixar", sem preview ✔web |
| | obra | **Não** | `…/portal/obras` | Registro bruto + saltar p/ **contrato da obra** (nº na `descricao`) ✔web |

> **BUG confirmado no repo (somente-leitura, NÃO corrigido neste plano de leitura):** `src/app/api/diario-oficial/empresas-sancionadas/route.ts:~73` monta `FILE_BASE + Arquivo.Url` (= `paifileserver/{Url}`) → **HTTP 404**. O correto é o endpoint `filemanager/pai/download?nomeArquivo=…&isInlineContent=true`. Mesmo bug em `scripts/cruzamento_sancionadas.py`, `scripts/cruzamento_pos_sancao.py` e documentado errado em `docs/transparencia-api-reference.md:~141`. **Correção fica na Fase 5 / pista separada** (mexe em código que funciona hoje, ainda que quebrado).

---

## Modelo de dados

Tudo opcional → **retrocompat total, zero migração**. A `Evidencia` do detector é o que viaja de ponta a ponta (a Function grava `...corpo`), então é nela que adicionamos `procedencia`. `ref` legado fica **intacto**.

### `src/lib/nexo/detectores/tipos.ts` (campos novos)

```ts
/** Procedência documental de uma evidência — de onde o dado saiu. */
export interface Procedencia {
  /** Sistema-fonte. */
  fonte: 'SMARAPD' | 'PNCP' | 'SICONFI' | 'TCE-SP' | 'DOM' | 'PORTAL-MARILIA';
  /** Rótulo do botão, ex.: 'Ver empenho no Portal da Transparência'. */
  label: string;
  /** URL da PROVA: deep-link, URL de API determinística, ou PDF. '' quando só há módulo. */
  url: string;
  /** Controla ícone e se renderiza preview. */
  tipoDoc: 'pdf' | 'pagina' | 'api-json' | 'modulo';
  /** true quando a url é PDF inline-embedável (SMARAPD filemanager, PNCP uri, DOM proxy). */
  podePreview: boolean;
  /** Ponteiro ao registro BRUTO coletado (prova de 2º nível). */
  refColecao?: string; // ex.: 'nexo_empenhos'
  refId?: string;      // = ID SMARAPD / numeroControlePNCP / sujeitoId DOM
}

export interface Evidencia {
  resumo: string;
  valor?: number;
  data?: string | null;
  ref?: string;               // LEGADO — mantido; nunca removido
  procedencia?: Procedencia;  // NOVO — opcional
}
```

### `src/lib/nexo/schemas.ts` (espelho Zod)

```ts
const procedenciaSchema = z.object({
  fonte: z.enum(['SMARAPD', 'PNCP', 'SICONFI', 'TCE-SP', 'DOM', 'PORTAL-MARILIA']),
  label: z.string(),
  url: z.string(),
  tipoDoc: z.enum(['pdf', 'pagina', 'api-json', 'modulo']),
  podePreview: z.boolean(),
  refColecao: z.string().optional(),
  refId: z.string().optional(),
});
// no evidenciaSchema:  procedencia: procedenciaSchema.optional(),
// + tornar refColecao/refId .optional() (hoje exigidos mas NÃO usados — a Function grava resumo/ref)
```

### `src/app/api/nexo/alertas/route.ts` (`paraAlerta`, +1 linha por evidência)

```ts
evidencias: evidenciasBrutas.map((ev) => {
  const e = (ev ?? {}) as Record<string, unknown>;
  return {
    resumo: texto(e.resumo),
    valor: e.valor != null ? numero(e.valor) : undefined,
    data: textoOuNulo(e.data),
    ref: textoOuNulo(e.ref) ?? undefined,
    procedencia: e.procedencia
      ? sanitizaProcedencia(e.procedencia as Procedencia)
      // legado sem reprocessar Firestore (Fase 4): deriva do ref+categoria
      : enriquecerProcedencia(textoOuNulo(e.ref), doc.categoria, sujeitoTipo, doc.exercicio),
  };
}),
```

**Nível Alerta: sem campo novo.** A procedência é por-evidência (um alerta tem N provas). Opcional: getter derivado `procedenciaPrincipal` (1ª evidência com procedência) computado só na resposta, sem persistir.

### Builder — `src/lib/nexo/procedencia.ts` (NOVO, função pura, sem I/O)

```ts
import { FONTES, MARILIA } from './constants';
import type { Procedencia } from './detectores/tipos';

const SMARAPD_SPA = FONTES.smarapd.replace('/paiportalserver', ''); // host da SPA

type Fonte = Procedencia['fonte'];
interface ProcedenciaInput {
  fonte: Fonte;
  ref?: string;
  exercicio: number;
  sujeitoTipo?: string;
  // SMARAPD-PDF:
  arquivoUrl?: string;        // já percent-encoded — passar VERBATIM
  // SICONFI:
  siconfi?: { tipo: 'RREO' | 'RGF' | 'DCA'; periodo: number; anexo: string; poder?: 'E' | 'L' };
  // TCE-SP:
  tce?: { orgaoId?: string; empenhoAno?: string };
}

/** Retorna null quando não há como provar (honesto). */
export function buildProcedencia(i: ProcedenciaInput): Procedencia | null {
  switch (i.fonte) {
    case 'SMARAPD':   return i.arquivoUrl ? smarapdPdf(i.arquivoUrl) : smarapdModulo(i);
    case 'PNCP':      return pncp(i.ref);
    case 'DOM':       return dom(i.ref);
    case 'SICONFI':   return i.siconfi ? siconfi(i.exercicio, i.siconfi) : null;
    case 'TCE-SP':    return tce(i.exercicio, i.tce);
    default:          return null;
  }
}

// (A) SMARAPD módulo — link de MÓDULO; a prova primária é o registro bruto
const MAPA_SMARAPD: Record<string, { mod: string; visao: string; col: string }> = {
  empenho:          { mod: 'fornecedor',            visao: 'fornecedoranalitico',    col: 'nexo_empenhos' },
  despesa:          { mod: 'DespesaAgrupada',       visao: 'DespesaseInvestimentos', col: 'nexo_despesas' },
  diaria:           { mod: 'diarias',               visao: 'diarias',                col: 'nexo_diarias' },
  'servidor-folha': { mod: 'pagamentos',            visao: 'pagamentoaservidores',   col: 'nexo_pagamentos' },
  resto:            { mod: 'restoapagar',           visao: 'restoapagar',            col: 'nexo_restos' },
  modalidade:       { mod: 'quadro_de_renda_local', visao: 'EmpenhoModalidade',      col: 'nexo_modalidades' },
};
function smarapdModulo(i: ProcedenciaInput): Procedencia | null {
  const m = MAPA_SMARAPD[i.sujeitoTipo ?? 'empenho'];
  if (!m) return null;
  return {
    fonte: 'SMARAPD', label: 'Ver módulo no Portal da Transparência',
    url: `${SMARAPD_SPA}/dinamico/${m.mod}/${m.visao}?exercicio=${i.exercicio}`,
    tipoDoc: 'modulo', podePreview: false,
    refColecao: m.col, refId: i.ref,
  };
}

// (B) SMARAPD PDF de visão fixa / portaria — deep-link DIRETO (corrige o bug 404 num só lugar)
function smarapdPdf(arquivoUrlVerbatim: string): Procedencia {
  return {
    fonte: 'SMARAPD', label: 'Abrir PDF original',
    url: `${FONTES.smarapdFiles}/filemanager/pai/download?nomeArquivo=${arquivoUrlVerbatim}&isInlineContent=true`,
    tipoDoc: 'pdf', podePreview: true, // CORS '*', sem Content-Disposition
  };
}

// (C) PNCP — roteia por tipo (caveat: id costuma ser '-1-' da compra)
const RE_PNCP = /^(\d{14})-([12])-0*(\d+)\/(\d{4})$/;
function pncp(ref?: string): Procedencia | null {
  const m = ref?.match(RE_PNCP);
  if (!m) return null;
  const [, cnpj, tipo, seq, ano] = m;
  const rota = tipo === '2' ? 'contratos' : 'editais';
  const apiPath = tipo === '2' ? 'contratos' : 'compras';
  return {
    fonte: 'PNCP', label: tipo === '2' ? 'Abrir contrato no PNCP' : 'Abrir edital no PNCP',
    url: `https://pncp.gov.br/app/${rota}/${cnpj}/${ano}/${seq}`,
    tipoDoc: 'pagina', podePreview: false, // SPA com frame-guard
    refColecao: 'nexo_contratos_pncp', refId: ref,
    // PDF (front exibe link): pncp.gov.br/api/pncp/v1/orgaos/${cnpj}/${apiPath}/${ano}/${seq}/arquivos
  };
}

// (D) DOM — interno; âncora de ato é frágil → linkar a EDIÇÃO
const RE_DOM = /^(\d{4})_(\d+)(?:_ato\d+)?$/;
function dom(ref?: string): Procedencia | null {
  const m = ref?.match(RE_DOM);
  if (!m) return null;
  const [, ano, ed] = m;
  return {
    fonte: 'DOM', label: 'Abrir edição do Diário Oficial',
    url: `/diario-oficial/${ano}/${ed}`,
    tipoDoc: 'pagina', podePreview: false,
    refColecao: 'nexo_diario', refId: `${ano}_${ed}`,
    // PDF embedável: /api/diario-oficial/edition/${ano}/${ed}/pdf (podePreview=true)
  };
}

// (E) SICONFI — URL determinística da API
function siconfi(ano: number, s: NonNullable<ProcedenciaInput['siconfi']>): Procedencia {
  const enc = encodeURIComponent(s.anexo);
  const base = `https://apidatalake.tesouro.gov.br/ords/siconfi/tt/${s.tipo.toLowerCase()}`;
  const q = s.tipo === 'RGF'
    ? `an_exercicio=${ano}&in_periodicidade=Q&nr_periodo=${s.periodo}&co_tipo_demonstrativo=RGF&co_poder=${s.poder ?? 'E'}&id_ente=${MARILIA.ibge}&no_anexo=${enc}`
    : `an_exercicio=${ano}&nr_periodo=${s.periodo}&co_tipo_demonstrativo=${s.tipo}&id_ente=${MARILIA.ibge}&no_anexo=${enc}`;
  return { fonte: 'SICONFI', label: 'Ver na fonte (SICONFI/STN)', url: `${base}?${q}`, tipoDoc: 'api-json', podePreview: false };
}

// (F) TCE-SP — empenho com ids; senão lista do exercício
function tce(ano: number, t?: ProcedenciaInput['tce']): Procedencia {
  if (t?.orgaoId && t?.empenhoAno) {
    return { fonte: 'TCE-SP', label: 'Ver empenho no Portal do TCE-SP',
      url: `https://transparencia.tce.sp.gov.br/municipio/marilia/${ano}/despesas/historico/${t.orgaoId}/${t.empenhoAno}`,
      tipoDoc: 'pagina', podePreview: false };
  }
  return { fonte: 'TCE-SP', label: 'Ver despesas no Portal do TCE-SP',
    url: `https://transparencia.tce.sp.gov.br/municipio/marilia/${ano}/despesas`,
    tipoDoc: 'modulo', podePreview: false };
}
```

> **PORTAL-MARILIA** (contrato/aditivo/edital) usa `{id}` interno + `{token}` opaco que **não são deriváveis** dos nossos campos (só scraping). O builder gera deep-link **só quando** a coleta já tiver persistido `id`/`token`; sem eles, cai no fallback `/portal/contratos` (`tipoDoc='modulo'`). Trabalho de coleta fica na Fase 5.

---

## UI — componente Fontes & Provas

A resolução roda **no client** a partir do `ref`/`sujeito` que já trafegam → funciona **hoje**, sem mexer em coleta/persistência. O builder puro pode ser reutilizado tanto na emissão (detector) quanto na leitura (client), via uma camada fina `resolverProvas`.

### `src/components/nexo/fontes-provas.tsx` (NOVO)

```tsx
import { ExternalLink, FileText, Eye, Link2 } from 'lucide-react';
import { useState } from 'react';
import type { Procedencia } from '@/lib/nexo/detectores/tipos';

const BADGE_CONF: Record<Procedencia['tipoDoc'], { txt: string; cls: string }> = {
  pdf:        { txt: 'Documento oficial', cls: 'text-emerald-300 bg-emerald-500/10' },
  pagina:     { txt: 'Página oficial',    cls: 'text-sky-300 bg-sky-500/10' },
  'api-json': { txt: 'API verificável',   cls: 'text-violet-300 bg-violet-500/10' },
  modulo:     { txt: 'Módulo/consulta',   cls: 'text-slate-300 bg-slate-500/10' },
};

function ProvaCard({ p }: { p: Procedencia }) {
  const [aberto, setAberto] = useState(false);
  const conf = BADGE_CONF[p.tipoDoc];
  const interno = p.url.startsWith('/');
  const pdfPreviewUrl = // DOM usa proxy interno; demais usam a própria url quando podePreview
    p.podePreview ? p.url : null;
  return (
    <div className="rounded-md border border-white/5 bg-[#0c0e13] p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-amber-300">{p.fonte}</span>
        <span className={`rounded px-1.5 py-0.5 text-[10px] ${conf.cls}`}>{conf.txt}</span>
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {p.url && (
          <a href={p.url} target={interno ? '_self' : '_blank'} rel="noopener noreferrer"
             className="inline-flex items-center gap-1 rounded border border-white/10 px-2 py-1 text-[11px] text-slate-200 hover:bg-white/5">
            <ExternalLink className="h-3 w-3" /> {p.label}
          </a>
        )}
        {pdfPreviewUrl && (
          <button onClick={() => setAberto((v) => !v)}
            className="inline-flex items-center gap-1 rounded border border-white/10 px-2 py-1 text-[11px] text-slate-200 hover:bg-white/5">
            <Eye className="h-3 w-3" /> {aberto ? 'Ocultar' : 'Pré-visualizar'}
          </button>
        )}
      </div>
      {/* registroBruto: tabela key→valor (mono 11px, brl(), dataPtBr(), mascararDoc) */}
      {aberto && pdfPreviewUrl && (
        <iframe src={pdfPreviewUrl} loading="lazy"
                className="mt-3 h-[60vh] w-full rounded-md border border-white/10" />
      )}
    </div>
  );
}

export function FontesProvas({ provas }: { provas: Procedencia[] }) {
  if (provas.length === 0) return null;
  return <div className="space-y-2">{provas.map((p, i) => <ProvaCard key={i} p={p} />)}</div>;
}
```

**Notas de embed:** DOM → proxy interno (same-origin, sem X-Frame issue). SMARAPD filemanager → CORS `*` confirmado, embeda direto. PNCP `/app` é SPA com frame-guard → **não embeda** (só botão "Abrir no PNCP"); o `uri` de `/arquivos` (PDF) é embedável quando coletado. Preview é **lazy** (iframe só monta ao abrir — evita N iframes no Sheet).

### Onde encaixa

```tsx
// src/components/nexo/alerta-detalhe.tsx — após a Seção "Evidências" (~linha 302)
<Secao icon={Link2} titulo="Fontes & Provas">
  <FontesProvas provas={alerta.evidencias.flatMap(e => e.procedencia ? [e.procedencia] : [])} />
</Secao>
```

Como **briefing** (`briefing/page.tsx:348`) e **dossiês** (`dossies/page.tsx:267`) abrem o **mesmo `AlertaDetalhe`**, esse único ponto cobre as três telas. Encaixes adicionais (opcionais): chips de fonte no `DossieCard` e ícone de `Paperclip` com contagem de provas-documento nas prioridades do briefing.

---

## Plano de implementação faseado

Cada fase é entregável sozinha. **Risco anotado por fase.** A regra: **ADITIVO** (campos opcionais, builder puro, nova UI) é seguro; **mexe-em-código-que-funciona** (corrigir rota de sanções, alterar coleta) fica isolado e por último.

| Fase | Conteúdo | Classe | Risco |
|---|---|---|---|
| **F1 — Modelo + builder** | Criar `src/lib/nexo/procedencia.ts` (builder puro + resolvers A–F). Adicionar `interface Procedencia` + `Evidencia.procedencia?` em `tipos.ts`. Espelhar `procedenciaSchema.optional()` em `schemas.ts` e tornar `refColecao/refId` opcionais. **Testes unitários puros:** regex PNCP (`-1-` vs `-2-`), encode-verbatim do `Arquivo.Url`, split DOM `{ano}_{edicao}_ato{idx}`, SICONFI RREO vs RGF. | **ADITIVO** | **Muito baixo** — sem efeito visível, sem I/O, sem tocar persistência/Function. Tudo opcional. |
| **F2 — UI liga o clicável** | Criar `fontes-provas.tsx`. Editar `alerta-detalhe.tsx` (após linha 302): nova `Secao` "Fontes & Provas" + preview iframe lazy. `ev.ref` em texto **permanece** como fallback. | **ADITIVO** | **Baixo** — adiciona seção; nenhuma evidência sem `procedencia` muda de aparência. Cobre as 3 telas de uma vez. |
| **F3 — Emissão incremental** | Migrar detectores **um a um** (começar **LC-01** fracionamento, **LC-19/LC-20** contratos-pncp-det, **DO-01/02/05** diario-det): trocar `ref: e.id` por `ref: e.id, procedencia: buildProcedencia({...})`. Builder é puro → roda dentro de `/api/nexo/detectar` sem mudar o contrato HTTP com a Function (que grava `...corpo`). | **ADITIVO** | **Baixo** — 1 detector por vez; não-migrados continuam só com `ref`. Reversível por detector. |
| **F4 — Legado sem reprocessar** | Em `route.ts` (`paraAlerta`), ligar `enriquecerProcedencia(ev.ref, categoria, sujeitoTipo, exercicio)` na **leitura**: alertas antigos ganham link derivado de `ev.ref + categoria` sem reprocessar Firestore. | **ADITIVO (leitura)** | **Baixo-médio** — toca a rota lida por todas as telas; mitigar com try/catch que retorna `undefined` em qualquer erro (degrada ao texto atual). |
| **F5 — Provas PDF fortes + coleta** | (a) **Corrigir o bug 404**: `empresas-sancionadas/route.ts:~73` → endpoint `filemanager/pai/download?...&isInlineContent=true` (idem 2 scripts + doc). Plugar `buildPdfVisaoFixa` nos alertas de empresa punida/LRF. (b) **Enriquecer coleta**: capturar `numeroControlePNCP` (`-2-`) p/ deep-link de contrato; `Arquivo.Url` das visões fixas; `orgaoId`/`empenho-ano` do TCE; `{id}`/`{token}` do Portal-Marília via scraping. | **MEXE-EM-CÓDIGO-QUE-FUNCIONA** (a) + **ADITIVO-coleta** (b) | **(a) Médio** — altera rota/scripts em produção (link de PDF hoje quebrado, mas é mudança de comportamento). Validar live (HTTP 200 + `%PDF`) antes de pushar. **(b) Baixo-médio** — adiciona campos opcionais na coleta; cada conector é independente. |

**Ordem de segurança:** F1→F2→F3→F4 são puramente aditivas e podem ir juntas sem tocar nada que funcione. F5 é a única que altera código vivo (a rota de sanções e os conectores) — isolá-la, validar contra a API ao vivo, e só então pushar (lembrando: push dispara deploy; e correções em `firestore`/`functions` exigem deploy separado — aqui não há mudança de rules/indexes, só app + Function de detecção, então App Hosting cobre o app e a Function de NEXO precisaria de `firebase deploy --only functions` **apenas se** o corpo da Function mudar; nas Fases F1–F4 a Function **não muda** — ela grava `...corpo` e a `procedencia` viaja de graça).

### Arquivos

**CRIAR:**
- `C:\Users\Vereador\Documents\oficioexpress\src\lib\nexo\procedencia.ts` (builder puro)
- `C:\Users\Vereador\Documents\oficioexpress\src\components\nexo\fontes-provas.tsx` (`<FontesProvas>` + iframe lazy + tabela bruta)

**EDITAR (aditivo):**
- `C:\Users\Vereador\Documents\oficioexpress\src\lib\nexo\detectores\tipos.ts` (`interface Procedencia` + `Evidencia.procedencia?`)
- `C:\Users\Vereador\Documents\oficioexpress\src\lib\nexo\schemas.ts` (`procedenciaSchema.optional()`; `refColecao/refId` → `.optional()`)
- `C:\Users\Vereador\Documents\oficioexpress\src\app\api\nexo\alertas\route.ts` (`paraAlerta`: copia/deriva `procedencia`)
- `C:\Users\Vereador\Documents\oficioexpress\src\components\nexo\alerta-detalhe.tsx` (nova `Secao` "Fontes & Provas" ~linha 302)
- Detectores migrados 1 a 1: `fracionamento.ts` (`ref:e.id`), `contratos-pncp-det.ts` (`sujeitoId=c.id`), `diario-det.ts` (`ref:ed.id`)

**EDITAR (F5, mexe-em-código-que-funciona — pista separada):**
- `C:\Users\Vereador\Documents\oficioexpress\src\app\api\diario-oficial\empresas-sancionadas\route.ts` (linha ~73: `FILE_BASE + Arquivo.Url` → `filemanager/pai/download?nomeArquivo=...&isInlineContent=true`)
- `C:\Users\Vereador\Documents\oficioexpress\scripts\cruzamento_sancionadas.py`, `scripts\cruzamento_pos_sancao.py`, `docs\transparencia-api-reference.md` (mesmo padrão errado)

**LER/REUSAR (referência):**
- `src\lib\nexo\constants.ts` (`FONTES.smarapdFiles/pncp/smarapd`; `MARILIA.ibge=3529005`)
- `src\lib\nexo\sources\smarapd.ts:96-108` (catálogo `ChaveModulo/NomeVisao`)
- `src\lib\nexo\sources\pncp.ts:259-268` (`ContratoPNCP.id` — caveat `-1-` primeiro)
- `src\app\api\diario-oficial\edition\[ano]\[edicao]\pdf\route.ts` (proxy PDF do DOM, embedável)
- `functions\src\nexo\deteccao.ts` (grava corpo verbatim — prova que `procedencia` viaja de graça)

### Testes

- **Unit `buildProcedencia`/parser:** PNCP `44477909000100-2-000001/2024` → `/app/contratos/.../2024/1`; `-1-` → `/app/editais`; DOM `2026_4188` e `2026_4188_ato3` → `/diario-oficial/2026/4188`; SMARAPD `Arquivo.Url` percent-encoded passa verbatim; SICONFI RREO vs RGF (params distintos); fontes sem prova (TCE julgado) → `null`.
- **Visual:** abrir alerta **DO-05** (extrato de contrato) → iframe do DOM + botão "Abrir edição"; abrir alerta **PNCP** → deep-link `/app/contratos`; alerta **empresa sancionada** (pós-F5) → preview inline da portaria.