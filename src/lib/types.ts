import { type Timestamp } from 'firebase/firestore';

export interface Comment {
  id: string;
  author: string;
  authorUid: string;
  date: Timestamp | Date | string;
  text: string;
  attachments?: { name: string; url: string }[];
}

export type OficioStatus =
  | 'Rascunho'
  | 'Aprovado'
  | 'Protocolado'
  | 'Aguardando Resposta'
  | 'Respondido'
  | 'Encerrado'
  | 'Lixeira'
  | 'Cancelado';

export type RequerimentoStatus = 'Rascunho' | 'Em Revisão' | 'Revisado' | 'Pautado' | 'Aprovado' | 'Finalizado';

export type IndicacaoStatus = 'Rascunho' | 'Em Revisão' | 'Revisado' | 'Pautado' | 'Aprovado' | 'Finalizado';

export type ProjetoDeLeiStatus =
  | 'Proposta'
  | 'Em Estudo'
  | 'Estudo Concluído'
  | 'Em Minuta'
  | 'Minuta Concluída'
  | 'Em Análise Jurídica'
  | 'Arquivado'
  | 'Cancelado';

export interface EventLogEntry {
  status: OficioStatus | RequerimentoStatus | IndicacaoStatus | ProjetoDeLeiStatus;
  actorUid: string;
  timestamp: Timestamp | Date;
  notes?: string;
}

export interface OficioAttachment {
  name: string;
  url: string;
  uploadedAt: Timestamp | Date;
  uploadedBy: string;
  path?: string;
  /** Nota/legenda de rodapé da imagem — exibida abaixo dela no PDF/impressão. */
  nota?: string;
}

export interface Oficio {
  id: string;
  numero: string;
  ano: number;
  destinatario: string;
  cargoDestinatario: string;
  vocativo: string;
  assunto: string;
  corpo: string;
  status: OficioStatus;
  createdAt: Timestamp | Date;
  updatedAt: Timestamp | Date;
  authorUid: string;
  attachments?: { name: string; url: string; path?: string; nota?: string }[];
  audioAttachments?: { name: string; url: string }[];
  eventLog: EventLogEntry[];
  pdfUrl?: string; // URL to the generated PDF in Storage
  pdfPath?: string; // Path in storage

  /** Quando true, o dia eh impresso como "___" no PDF (ex: "___ de maio de 2026"). */
  omitirDia?: boolean;
  
  approvedAt?: Timestamp | Date;
  approvedBy?: string;
  
  protocolAt?: Timestamp | Date;
  protocolBy?: string;
  protocolNumber?: string;
  protocoloArquivo?: OficioAttachment;

  responseSummary?: string;
  respondedAt?: Timestamp | Date;
  respondedBy?: string;
  respostaArquivo?: OficioAttachment;

  closedAt?: Timestamp | Date;
  closedBy?: string;
}


export interface Requerimento {
  id: string;
  numero: string;
  ano: number;
  assunto: string;
  destinatario: string;
  corpo: string;
  status: RequerimentoStatus;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  authorUid: string;
  originalCorpo?: string;
  eventLog: EventLogEntry[];
  attachments?: { name: string; url: string }[];
  revisaoIA?: {
    revisadoEm: Timestamp;
    textoRevisado: string;
  };
  dataPauta?: Timestamp | Date;
  pautadoPor?: string;
  pautadoEm?: Timestamp | Date;
  aprovadoNaSessao?: boolean;
  saplCodmateria?: string;
  saplNumero?: string;
}

export interface Indicacao {
  id: string;
  numero: string;
  ano: number;
  assunto: string;
  destinatario: string;
  corpo: string;
  status: IndicacaoStatus;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  authorUid: string;
  originalCorpo?: string;
  eventLog: EventLogEntry[];
  attachments?: { name: string; url: string }[];
  revisaoIA?: {
    revisadoEm: Timestamp;
    textoRevisado: string;
  };
  dataPauta?: Timestamp | Date;
  pautadoPor?: string;
  pautadoEm?: Timestamp | Date;
  aprovadoNaSessao?: boolean;
  saplCodmateria?: string;
  saplNumero?: string;
}

export interface ViabilityStudy {
  id: string;
  title: string;
  content: string; // HTML content
  createdAt: Timestamp | Date;
  actorUid: string;
}

export interface ProjetoDeLei {
  id: string;
  proposta: string;
  titulo?: string;
  ementa?: string;
  numero?: string;
  ano: number;
  status: ProjetoDeLeiStatus;
  estudosDeViabilidade?: ViabilityStudy[];
  analiseJuridica?: ViabilityStudy[];
  minuta?: string;
  justificativa?: string;
  authorUid: string;
  createdAt: Timestamp | Date;
  updatedAt: Timestamp | Date;
  eventLog: EventLogEntry[];
  attachments?: { name: string; url: string }[];
  saplCodmateria?: string;
  saplNumero?: string;
}

export interface UserProfile {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
  role: 'admin' | 'user';
  isActive: boolean;
}

export interface OficioImportData {
  numero: string;
  ano: number;
  dataOficio: string;
  destinatario: string;
  cargoDestinatario: string;
  assunto: string;
  corpo: string;
  vocativo: string;
  existingOficioId?: string;
  duplicateReason?: 'content-similar' | 'content-different';
}

export interface OficioImportLog {
  id: string;
  actorUid: string;
  importedAt: Timestamp;
  revertedAt?: Timestamp;
  revertedBy?: string;
  oficioId: string;
  oficioNumero: string;
  oficioAno: number;
  status: 'imported' | 'reverted';
  originalPdfPath: string;
  importData: OficioImportData & { status: OficioStatus };
}

export interface UploadToken {
  id: string;
  oficioId: string;
  action: 'protocolo' | 'resposta';
  createdAt: Timestamp;
  expiresAt: Timestamp;
  used: boolean;
  attachments?: { name: string; url: string }[];
}

export interface RecorteFolder {
  id: string;
  name: string;
  description: string;
  isPublic: boolean;
  accessKey?: string;
  password?: string;
  createdAt: Timestamp | Date;
  authorUid: string;
}

export type CompressionStatus = 'pending' | 'compressing' | 'complete' | 'error' | 'cancelled';

export interface RecorteVideo {
  id: string;
  name: string;
  description: string;
  filePath: string;
  fileUrl?: string; // Generated on client
  size?: number; // Size in bytes
  thumbnailPath?: string;
  thumbnailUrl?: string; // Generated on client
  previewPath?: string; // Rendition leve (720p+faststart) no bucket de São Paulo
  previewUrl?: string; // URL pública do preview — o player usa esta se existir
  createdAt: Timestamp | Date;
  uploaderUid: string;
  compressionJobId?: string;
  quickEditJobId?: string;
}

export type CompressionTier = 'small' | 'medium' | 'large';

export interface CompressionJob {
  id: string;
  videoId: string;
  folderId: string;
  videoFilePath: string;
  status: CompressionStatus;
  quality: 'low' | 'medium' | 'high';
  /** Tier de recursos da Cloud Function (selecionado pelo tamanho do arquivo). */
  tier?: CompressionTier;
  /** Tamanho do arquivo de origem em bytes. */
  sourceSize?: number;
  progress: number;
  originalSize?: number;
  finalSize?: number;
  error?: string;
  requestedAt: Timestamp | Date;
  completedAt?: Timestamp | Date;
  /** Auto-delete via TTL do Firestore (default: now + 14 dias). */
  expiresAt?: Timestamp;
}

/**
 * Modo de destino do vídeo editado:
 * - `replace` (default p/ retrocompat): sobrescreve o arquivo original do recorte.
 * - `new-copy`: cria um NOVO documento RecorteVideo na mesma pasta.
 * - `download`: salva em `renders/` e expõe `outputUrl` — não toca em `recortes/`.
 */
export type QuickEditSaveMode = 'download' | 'new-copy' | 'replace';

export interface QuickEditJob {
  id: string;
  videoId: string;
  folderId: string;
  videoFilePath: string;
  status: 'pending' | 'processing' | 'complete' | 'error';
  settings: {
    trimStart: string; // MM:SS format
    trimEnd: string; // MM:SS format
    addLogo: boolean;
    addFooter: boolean;
    addEnding: boolean;
    aspectRatio: '9:16' | '4:5';
    scaleMode?: 'fit' | 'fill';
    saveMode?: QuickEditSaveMode;
    /** Nome customizado pro recorte (modo new-copy). Sem isso, vira "X (editado)". */
    customName?: string;
  };
  progress?: number;
  error?: string;
  /** UID de quem solicitou (necessário para o caminho renders/{uid}/ no download mode). */
  requestedByUid?: string;
  /** URL do arquivo renderizado (modo download/new-copy/replace). */
  outputUrl?: string;
  /** Path do arquivo renderizado no Storage. */
  outputPath?: string;
  /** ID do vídeo salvo (modo new-copy = novo, replace = mesmo videoId). */
  savedVideoId?: string;
  requestedAt: Timestamp | Date;
  completedAt?: Timestamp | Date;
  /** Auto-delete via TTL do Firestore (default: now + 14 dias). Para mode=download. */
  expiresAt?: Timestamp;
}

export interface Compromisso {
  id: string;
  title: string;
  description?: string;
  startTime: Timestamp;
  endTime: Timestamp;
  allDay: boolean;
  location?: string;
  authorUid: string;
  createdAt?: Timestamp | Date;
  updatedAt?: Timestamp | Date;
}

export interface TranscriptionGroup {
  id: string;
  name: string;
  authorUid: string;
  createdAt: Timestamp;
  fileCount: number;
  type: 'group';
  transcriptions: Transcription[];
}

export interface Transcription {
  id: string;
  groupId?: string;
  name: string;
  audioPath: string;
  transcription: string;
  status: 'processing' | 'completed' | 'error';
  error?: string;
  createdAt: Timestamp;
  expiresAt: Timestamp;
  authorUid: string;
  type: 'transcription';
}

export interface SaplMateria {
  id: string; // Firestore doc ID
  codmateria: string;
  numero: string;
  ano: number;
  tipo: string;
  ementa: string;
  autoria: string;
  linkArquivo: string;
  prazo?: string;
  lastSyncedAt: Timestamp;
}

export interface ImportBatchFile {
  fileName: string;
  storagePath: string;
  status: 'pending' | 'processing' | 'success' | 'error' | 'skipped' | 'duplicate';
  extractedData?: OficioImportData;
  error?: string;
  logId?: string;
}

export interface ImportBatch {
  id: string;
  userId: string;
  createdAt: Timestamp;
  status: 'pending' | 'processing' | 'completed' | 'cancelled';
  files: ImportBatchFile[];
}

export interface PdfSettings {
  fontFamily?: 'times' | 'helvetica' | 'courier';
  fontSize?: number;
  lineSpacing?: number;
  paragraphSpacing?: number;
  marginTop?: number;
  marginRight?: number;
  marginBottom?: number;
  marginLeft?: number;
  headerFontSizeMultiplier?: number;
  firstLineIndent?: number;
}

export interface AppearanceConfig {
  brasaoUrl?: string;
  videoLogoUrl?: string;
  videoFooterUrl?: string;
  videoEncerramentoUrl?: string;
  lastSaplSync?: Timestamp | Date;
  aiKnowledgeBaseUrl?: string;
  pdfSettings?: PdfSettings;
}

// =====================================================================
// Diário Oficial — Marília-SP
// =====================================================================

export interface DiarioEdition {
  id: string;                     // formato: "2026_4188" (ano_numero)
  ano: number;
  numero: number;                 // número da edição
  data: Timestamp;                // data de publicação
  paginas: number;
  pdfUrl: string;                 // URL Storage interna (download) — opcional quando texto vem direto
  pdfOriginalUrl: string;         // URL original na prefeitura
  pdfPath: string;                // path no Storage — vazio quando ingerido via dados-abertos
  rawText?: string;               // texto integral da edição (vem direto de dados-abertos da prefeitura)
  textChars?: number;             // tamanho do texto bruto
  status: 'pending_fetch' | 'pending_parse' | 'parsing' | 'parsed' | 'error';
  parsedAt?: Timestamp;
  hash?: string;                  // SHA-256 do PDF (quando aplicável)
  totalMatters?: number;
  totalValue?: number;            // soma de valores monetários
  edicaoExtra?: boolean;
  source: 'querido-diario' | 'scrape-direct' | 'marilia-dados-abertos';
  error?: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export type DiarioMatterType =
  | 'decreto'
  | 'lei'
  | 'portaria'
  | 'resolucao'
  | 'licitacao'
  | 'dispensa_licitacao'
  | 'contrato'
  | 'extrato'
  | 'edital'
  | 'ato_administrativo'
  | 'dotacao'
  | 'outro';

export interface DiarioMatter {
  id: string;
  diarioId: string;
  tipo: DiarioMatterType;
  numero?: string;                // ex: "8.421/2026"
  data?: Timestamp;
  ementa: string;                 // resumo
  texto: string;                  // texto completo
  paginaInicio: number;
  paginaFim: number;
  pessoasMencionadas: {
    nome: string;
    cpf?: string;             // legado: CPF cru vindo do parser (pode estar mascarado)
    cpfFull?: string;         // CPF completo (apenas dígitos) — usado p/ indexar entities.cpfFull
    cpfMasked?: string;       // CPF mascarado (***.456.789-**)
    cargo?: string;
    rg?: string;              // RG cru como aparece no DO
    rgFull?: string;          // RG completo publicado no DOM
  }[];
  empresasMencionadas: { razaoSocial: string; cnpj?: string }[];
  orgaosMencionados: string[];
  valores: { valor: number; descricao: string; codigoOrcamentario?: string }[];
  referenciasCruzadas: { tipo: DiarioMatterType; numero: string; ano?: number }[];
  entityRefs: { type: 'pessoa' | 'empresa' | 'orgao'; id: string; role?: string }[];
  createdAt: Timestamp;
}

export type DiarioEntityType = 'pessoa' | 'empresa' | 'orgao';

export interface DiarioEntity {
  id: string;                     // type_normalizedKey (ex: "empresa_12345678000190")
  type: DiarioEntityType;
  displayName: string;

  // --- Pessoa física ---
  cpfFull?: string;               // CPF completo (apenas dígitos) — acesso público (LAI)
  cpfMasked?: string;             // versão mascarada (***.456.789-**) — opcional, fallback de UI
  rg?: string;                    // RG (valor cru como aparece no DO) — compat
  rgFull?: string;                // RG completo como publicado no DOM — acesso público (LAI)
  rgOrgaoEmissor?: string;        // ex: "SSP/SP"
  dataNascimento?: string;        // YYYY-MM-DD quando disponível

  // --- Empresa ---
  cnpj?: string;
  razaoSocialAlternativas?: string[];
  cnaePrincipal?: string;
  socios?: { nome: string; cpfFull?: string; participacao?: number }[];

  // --- Endereço/contato (qualquer tipo) ---
  enderecos?: { logradouro: string; numero?: string; bairro?: string; cidade?: string; uf?: string; cep?: string }[];
  telefones?: string[];
  emails?: string[];

  // --- Cargo/relação institucional (pessoa) ---
  cargos?: { titulo: string; orgao?: string; periodoInicio?: string; periodoFim?: string }[];

  // --- Comum ---
  aliases: string[];
  appearancesCount: number;
  totalContractValue?: number;
  firstSeenAt?: Timestamp;
  lastSeenAt?: Timestamp;
  updatedAt: Timestamp;
}

export interface BudgetCode {
  codigo: string;                 // ex: "02.10.10.301.0042.2.119.339030"
  hierarquia: string[];           // ['Saude', 'Atenção Básica', ...]
  descricao: string;
  source: string;                 // 'LOA-2026'
  ano: number;
  unresolved?: boolean;
  updatedAt: Timestamp;

  // ---- Campos opcionais (preenchidos quando vêm do parser da LOA) -------
  orgao?: string;                 // ex: "Secretaria Municipal de Saúde"
  orgaoCodigo?: string;           // ex: "02"
  uo?: string;                    // unidade orçamentária (ex: "Fundo Municipal de Saúde")
  uoCodigo?: string;              // ex: "02"
  funcao?: string;                // ex: "Saúde"
  funcaoNome?: string;            // alias humanamente legível
  funcaoCodigo?: string;          // ex: "10"
  subfuncao?: string;             // ex: "Atenção Básica"
  subfuncaoNome?: string;
  subfuncaoCodigo?: string;       // ex: "301"
  programa?: string;              // ex: "Saúde da Família"
  programaCodigo?: string;        // ex: "0023"
  acao?: string;                  // ex: "Manutenção das ESF"
  acaoCodigo?: string;            // ex: "2.057"
  categoriaEconomica?: string;    // "Despesas Correntes" | "Despesas de Capital"
  categoriaEconomicaCodigo?: string; // "3" | "4"
  grupoDespesa?: string;          // ex: "Outras Despesas Correntes"
  grupoDespesaCodigo?: string;    // ex: "3"
  modalidadeAplicacao?: string;
  modalidadeAplicacaoCodigo?: string; // ex: "90"
  elemento?: string;              // ex: "Material de Consumo"
  elementoCodigo?: string;        // ex: "30"
  subelemento?: string;
  subelementoCodigo?: string;
  fonteRecurso?: string;
  fonteRecursoCodigo?: string;
  valor?: number;                 // dotação inicial em reais
}

// =====================================================================
// Diário Oficial — Backfill histórico via Querido Diário
// =====================================================================

export type DiarioBackfillStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'complete'
  | 'error'
  | 'cancelled';

export interface DiarioBackfillJob {
  id: string;
  startDate: string;          // YYYY-MM-DD
  endDate: string;            // YYYY-MM-DD (default: hoje)
  status: DiarioBackfillStatus;
  totalEditions: number;      // total estimado da API
  processedEditions: number;
  skippedEditions: number;    // já existiam em Firestore
  errorEditions: number;
  currentDate?: string;       // YYYY-MM-DD em processamento
  progress: number;           // 0-100
  error?: string;
  createdAt: Timestamp;
  startedAt?: Timestamp;
  completedAt?: Timestamp;
  pausedAt?: Timestamp;
  ownerUid: string;
}

// =====================================================================
// Legendas via IA — Suite Editor de Vídeos
// =====================================================================

export type CaptionJobStatus =
  | 'pending'
  | 'mixing'
  | 'transcribing'
  | 'aligning'
  | 'complete'
  | 'error'
  | 'cancelled';

export interface CaptionGenerationJob {
  id: string;
  projectId: string;
  ownerUid: string;
  status: CaptionJobStatus;
  language: string;              // 'pt-BR', 'en', 'es'
  model: 'gemini-2.5-flash' | 'gemini-2.5-pro';
  needsServerMix: boolean;
  mixedAudioPath?: string;       // gs path quando client mixou
  captionTrackId?: string;       // criada ao concluir
  srtStoragePath?: string;
  progress: number;              // 0-100
  error?: string;
  createdAt: Timestamp;
  completedAt?: Timestamp;
}
