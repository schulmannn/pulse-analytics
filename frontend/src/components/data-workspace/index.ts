// Small, presentation-focused primitives shared by dense desktop "data workspace" tables
// (Instagram Content, campaign posts, …). Built on the app's own design system — the shared
// SegmentedControl, the shadcn/Radix Button + DropdownMenu and DESIGN_TOKENS utilities; no domain
// logic lives here. The former `WorkspaceSurface` existed only to mount the Astryx <Theme> and was
// dropped with the pilot: it wrapped children in a `display: contents` node and carried no layout.
export {
  WorkspaceViewToolbar,
  WORKSPACE_DENSITY_OPTIONS,
  type WorkspaceDensity,
  type WorkspaceColumnOption,
} from './WorkspaceViewToolbar';
export {
  WorkspaceInspector,
  WorkspaceMetadataList,
  WorkspaceMetadataItem,
} from './WorkspaceInspector';
