/**
 * Computa flags de risco de um fornecedor a partir dos dados cadastrais
 * enriquecidos. Cada flag é indício a apurar — ver docs/nexo-plano-mestre.md.
 */
import type { CnpjInfo } from './sources/cnpj';

export interface FornecedorFlag {
  tipo: 'outra_uf' | 'recem_criada' | 'situacao_irregular' | 'inidoneo';
  nivel: 'atencao' | 'suspeita' | 'critico';
  titulo: string;
  descricao: string;
}

function mesesDesde(iso: string): number {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return Infinity;
  return (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24 * 30.44);
}

export function computarFlagsFornecedor(
  info: CnpjInfo,
  sancoes?: { ceis: number; cnep: number },
): FornecedorFlag[] {
  const flags: FornecedorFlag[] = [];

  if (info.uf && info.uf.toUpperCase() !== 'SP') {
    flags.push({
      tipo: 'outra_uf',
      nivel: 'atencao',
      titulo: 'Empresa sediada em outra UF',
      descricao:
        `Sede em ${info.municipio ?? '—'}/${info.uf}. Verificar a capacidade de ` +
        `execução de serviços presenciais em Marília.`,
    });
  }

  if (info.dataAbertura) {
    const meses = mesesDesde(info.dataAbertura);
    if (meses < 12) {
      flags.push({
        tipo: 'recem_criada',
        nivel: 'suspeita',
        titulo: 'Empresa recém-criada',
        descricao:
          `Aberta há cerca de ${Math.max(0, Math.round(meses))} meses. Empresa nova ` +
          `vencendo contrato relevante é ponto clássico de atenção.`,
      });
    }
  }

  if (info.situacaoCadastral && !/ATIVA/i.test(info.situacaoCadastral)) {
    flags.push({
      tipo: 'situacao_irregular',
      nivel: 'critico',
      titulo: `Situação cadastral: ${info.situacaoCadastral}`,
      descricao:
        'Fornecedor com CNPJ fora da situação ATIVA recebendo recursos públicos ' +
        'requer apuração imediata.',
    });
  }

  if (sancoes && (sancoes.ceis > 0 || sancoes.cnep > 0)) {
    const cadastros = [
      sancoes.ceis > 0 ? 'CEIS' : null,
      sancoes.cnep > 0 ? 'CNEP' : null,
    ].filter(Boolean).join(' e ');
    flags.push({
      tipo: 'inidoneo',
      nivel: 'critico',
      titulo: 'Empresa em cadastro de inidôneos',
      descricao:
        `Consta em ${cadastros} — impedida de contratar com a administração ` +
        `pública. Pagamento a empresa inidônea é irregularidade grave.`,
    });
  }

  return flags;
}
