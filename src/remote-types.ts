import type {
  ManifestIntegrity,
  ManifestSignature,
  ManifestSignatureKey,
} from "./remote-manifest-integrity";

export type RemoteItemType = "skill" | "mcp" | "agent" | "snippet";

export interface RemoteSkillPayload {
  name: string;
  files: Record<string, string>;
}

export interface RemoteMcpPayload {
  name: string;
  definition: Record<string, unknown>;
}

export interface RemoteAgentPayload {
  fileName: string;
  content: string;
}

export interface RemoteSnippetPayload {
  marker: string;
  content: string;
}

export interface RemoteIndexItemBase {
  id: string;
  type: RemoteItemType;
  title?: string;
  description?: string;
  version?: string;
  tags?: string[];
  sourceUrl?: string;
}

export interface RemoteSkillItem extends RemoteIndexItemBase {
  type: "skill";
  skill: RemoteSkillPayload;
}

export interface RemoteMcpItem extends RemoteIndexItemBase {
  type: "mcp";
  mcp: RemoteMcpPayload;
}

export interface RemoteAgentItem extends RemoteIndexItemBase {
  type: "agent";
  agent: RemoteAgentPayload;
}

export interface RemoteSnippetItem extends RemoteIndexItemBase {
  type: "snippet";
  snippet: RemoteSnippetPayload;
}

export type RemoteIndexItem =
  | RemoteSkillItem
  | RemoteMcpItem
  | RemoteAgentItem
  | RemoteSnippetItem;

export interface RemoteIndexManifest {
  name: string;
  url: string;
  updatedAt?: string;
  items: RemoteIndexItem[];
}

export type IndexSourceKind =
  | "builtin"
  | "manifest"
  | "smithery"
  | "glama"
  | "skills-sh"
  | "clawhub";

export interface IndexSource {
  name: string;
  url: string;
  kind: IndexSourceKind;
  integrity?: ManifestIntegrity;
  signature?: ManifestSignature;
  signatureKeys?: ManifestSignatureKey[];
}

export interface LoadManifestHints {
  query?: string;
  itemId?: string;
}

export const BUILTIN_INDEX_NAME = "facult";
export const BUILTIN_INDEX_URL = "builtin://facult";
export const SMITHERY_INDEX_NAME = "smithery";
export const GLAMA_INDEX_NAME = "glama";
export const SKILLS_SH_INDEX_NAME = "skills.sh";
export const CLAWHUB_INDEX_NAME = "clawhub";
export const SMITHERY_API_BASE = "https://api.smithery.ai";
export const GLAMA_API_BASE = "https://glama.ai/api/mcp/v1";
export const SKILLS_SH_WEB_BASE = "https://skills.sh";
export const CLAWHUB_API_BASE = "https://wry-manatee-359.convex.site/api/v1";

export const KNOWN_PROVIDER_SOURCES: Record<string, IndexSource> = {
  [SMITHERY_INDEX_NAME]: {
    name: SMITHERY_INDEX_NAME,
    url: SMITHERY_API_BASE,
    kind: "smithery",
  },
  [GLAMA_INDEX_NAME]: {
    name: GLAMA_INDEX_NAME,
    url: GLAMA_API_BASE,
    kind: "glama",
  },
  [SKILLS_SH_INDEX_NAME]: {
    name: SKILLS_SH_INDEX_NAME,
    url: SKILLS_SH_WEB_BASE,
    kind: "skills-sh",
  },
  [CLAWHUB_INDEX_NAME]: {
    name: CLAWHUB_INDEX_NAME,
    url: CLAWHUB_API_BASE,
    kind: "clawhub",
  },
  "skills-sh": {
    name: SKILLS_SH_INDEX_NAME,
    url: SKILLS_SH_WEB_BASE,
    kind: "skills-sh",
  },
  "clawhub.ai": {
    name: CLAWHUB_INDEX_NAME,
    url: CLAWHUB_API_BASE,
    kind: "clawhub",
  },
};
