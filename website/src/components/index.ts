// Stable import surface for ingested MDX pages (`@site/components`): the
// site-local wrappers content needs beyond Starlight's own components,
// plus re-exports of the Starlight components used in docs so every import
// line uses one specifier. Individual Starlight components re-export FROM
// the barrel (`@astrojs/starlight/components`): the package's subpath
// exports only cover the core components directory, not the user-facing
// ones the barrel collects.
export { default as LinkCard } from './LinkCardBase.astro';
export {
  Aside,
  Badge,
  Card,
  CardGrid,
  FileTree,
  LinkButton,
  Steps,
  TabItem,
  Tabs,
} from '@astrojs/starlight/components';
