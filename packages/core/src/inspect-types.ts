/**
 * HTTP contract of GET /r/v1/{R}/inspect.json and of error responses,
 * shared by the Worker (producer) and the web UI (consumer).
 */
import type { Diagnostic } from './diagnostics.ts';
import type { DocumentFormat, InputFormat } from './document-parser.ts';
import type { RecipeLinks } from './integration.ts';
import type { Recipe } from './recipe.ts';

export interface InspectTarget {
  target: string;
  providerName: string;
  ruleCount: number;
  providerUrl: string;
}

export interface InspectResponse {
  ok: true;
  recipe: Recipe;
  recipeToken: string;
  recipeId: string;
  compilerVersion: string;
  mihomoBaseline: string;
  /** Always "structural": the service does not run a Mihomo kernel. */
  validation: 'structural';
  status: {
    stale: boolean;
    cache: 'hit' | 'miss' | 'revalidated' | 'stale';
    validatedAt: string;
    lastError: { code: string; message: string } | null;
  };
  source: {
    url: string;
    format: InputFormat;
    detectedFormat: DocumentFormat;
    digest: string;
    explicitEmpty: boolean;
    ruleCount: number;
  };
  links: RecipeLinks;
  targets: InspectTarget[];
  diagnostics: Diagnostic[];
  diagnosticsTruncated: boolean;
  notices: string[];
}

export interface ErrorResponse {
  ok: false;
  error: { code: string; message: string };
  diagnostics?: Diagnostic[];
  upstreamStatus?: number;
}

export interface ConfigResponse {
  ok: true;
  publicBaseUrl: string;
  allowlist: string[];
  limits: Record<string, number>;
  cache: { freshSeconds: number; staleSeconds: number };
  compilerVersion: string;
  mihomoBaseline: string;
}
