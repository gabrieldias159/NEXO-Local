/**
 * Limites de dispensa de licitação — art. 75, I e II, da Lei 14.133/2021.
 *
 * Os valores são atualizados anualmente por decreto federal. Esta tabela é a
 * FONTE ÚNICA do detector de fracionamento (P1) — nunca usar uma constante
 * digitada à mão dentro de um detector (anti-padrão que gera falso positivo
 * e falso negativo sistemáticos).
 *
 * ⚠ Backlog Fase 0 #7: confirmar cada linha contra o texto do decreto.
 */

export interface LimiteDispensa {
  exercicio: number;
  /** Art. 75, II — outros serviços e compras. */
  comprasServicos: number;
  /** Art. 75, I — obras e serviços de engenharia. */
  obrasEngenharia: number;
  /** Decreto federal que fixou os valores para o exercício. */
  decreto: string;
}

/** Tabela por exercício, do mais recente para o mais antigo. */
const TABELA: readonly LimiteDispensa[] = [
  { exercicio: 2026, comprasServicos: 65492.11, obrasEngenharia: 130984.2, decreto: 'Decreto 12.807/2025' },
  { exercicio: 2025, comprasServicos: 62725.59, obrasEngenharia: 125451.15, decreto: 'Decreto 12.343/2024' },
  { exercicio: 2024, comprasServicos: 59906.02, obrasEngenharia: 119812.02, decreto: 'Decreto 11.871/2023' },
  { exercicio: 2023, comprasServicos: 57208.33, obrasEngenharia: 114416.65, decreto: 'Decreto 11.317/2022' },
];

/**
 * Retorna os limites de dispensa do exercício. Para exercícios fora da tabela,
 * usa o mais recente conhecido e marca `exato: false` — o detector deve sempre
 * checar esse flag.
 */
export function getLimiteDispensa(exercicio: number): LimiteDispensa & { exato: boolean } {
  const match = TABELA.find((l) => l.exercicio === exercicio);
  if (match) return { ...match, exato: true };
  return { ...TABELA[0], exato: false };
}

/** Lista completa da tabela (para exibição na UI). */
export function listLimitesDispensa(): readonly LimiteDispensa[] {
  return TABELA;
}
