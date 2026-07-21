// Small, presentation-focused primitives shared by dense desktop "data workspace" tables
// (Instagram Content, campaign posts, …). They wrap verified Astryx exports; no domain logic lives
// here. See frontend/AGENTS.md for the Astryx CLI workflow before extending the API surface.
export { WorkspaceSurface } from './WorkspaceSurface';
export {
  WorkspaceViewToolbar,
  WORKSPACE_DENSITY_OPTIONS,
  WORKSPACE_DENSITY_CELL,
  WORKSPACE_DENSITY_HEAD,
  type WorkspaceDensity,
  type WorkspaceColumnOption,
} from './WorkspaceViewToolbar';
export { WorkspaceInspector } from './WorkspaceInspector';
