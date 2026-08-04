/**
 * Rastreador de prazos de publicação dos relatórios fiscais.
 *
 * Atende a red flag mais citada nas transcrições do advogado — "prazo é linha
 * vermelha": gestor multado não por desvio, mas por perder o prazo de
 * publicação de RREO/RGF.
 *
 * Lógica pura de calendário (LRF, arts. 52 e 55). RREO é bimestral; RGF, para
 * o município, quadrimestral. Ambos devem ser publicados em até 30 dias após o
 * encerramento do período. Toda a comparação é feita em datas-only (yyyy-MM-dd)
 * na mesma base, evitando o erro de fuso de comparar timestamps crus.
 */

export type SituacaoPrazo = 'futuro' | 'aberto' | 'vence_em_breve' | 'encerrado';

export interface PrazoFiscal {
  tipo: 'RREO' | 'RGF';
  rotulo: string;
  /** Data-limite de publicação (ISO yyyy-MM-dd). */
  prazo: string;
  situacao: SituacaoPrazo;
  /** Dias inteiros até o prazo (negativo = prazo já encerrado). */
  diasRestantes: number;
}

/** Data de calendário (local) de um Date, como ISO yyyy-MM-dd. */
function isoLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/** Diferença em dias inteiros entre duas datas-only ISO (positivo: a depois de b). */
function diffDias(aIso: string, bIso: string): number {
  const a = Date.parse(`${aIso}T00:00:00Z`);
  const b = Date.parse(`${bIso}T00:00:00Z`);
  return Math.round((a - b) / 86_400_000);
}

function montar(
  tipo: 'RREO' | 'RGF',
  rotulo: string,
  prazoIso: string,
  hojeIso: string,
): PrazoFiscal {
  const dias = diffDias(prazoIso, hojeIso);
  let situacao: SituacaoPrazo;
  if (dias < 0) situacao = 'encerrado';
  else if (dias <= 15) situacao = 'vence_em_breve';
  else if (dias <= 60) situacao = 'aberto';
  else situacao = 'futuro';
  return { tipo, rotulo, prazo: prazoIso, situacao, diasRestantes: dias };
}

/** Último dia do mês `mes` (0-base no construtor) + 30 dias → ISO yyyy-MM-dd. */
function prazoMais30(exercicio: number, mesFim: number): string {
  const fim = new Date(Date.UTC(exercicio, mesFim, 0)); // dia 0 = último do mês anterior
  fim.setUTCDate(fim.getUTCDate() + 30);
  return fim.toISOString().slice(0, 10);
}

/**
 * Calcula os prazos de publicação de RREO (6 bimestres) e RGF (3
 * quadrimestres) do exercício, com a situação de cada um na data de hoje.
 */
export function calcularPrazosFiscais(
  exercicio: number,
  hoje: Date = new Date(),
): PrazoFiscal[] {
  const hojeIso = isoLocal(hoje);
  const out: PrazoFiscal[] = [];

  for (let b = 1; b <= 6; b++) {
    out.push(
      montar('RREO', `RREO — ${b}º bimestre/${exercicio}`, prazoMais30(exercicio, b * 2), hojeIso),
    );
  }
  for (let q = 1; q <= 3; q++) {
    out.push(
      montar('RGF', `RGF — ${q}º quadrimestre/${exercicio}`, prazoMais30(exercicio, q * 4), hojeIso),
    );
  }

  return out.sort((a, b) =>
    a.prazo < b.prazo ? -1 : a.prazo > b.prazo ? 1 : a.tipo < b.tipo ? -1 : 1,
  );
}
