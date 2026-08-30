import type { ComponentType } from 'react';

/**
 * The example registry.
 *
 * Examples are discovered from the filesystem rather than listed by hand, so
 * adding `src/examples/15-whatever.tsx` puts it in the menu with no other edit.
 * The `?raw` glob loads each file's own source alongside it, which is how every
 * page can show the exact code that is running above it.
 */

export interface ExampleMeta {
  /** Menu label. */
  title: string;
  /** One line under the title. */
  blurb: string;
}

export interface Example extends ExampleMeta {
  /** URL slug, derived from the filename: `02-objects.tsx` -> `objects`. */
  id: string;
  Component: ComponentType;
  source: string;
}

type Module = { default: ComponentType; meta: ExampleMeta };

const modules = import.meta.glob<Module>('./examples/*.tsx', { eager: true });
const sources = import.meta.glob<string>('./examples/*.tsx', {
  eager: true,
  query: '?raw',
  import: 'default',
});

function slug(path: string): string {
  // "./examples/02-objects.tsx" -> "objects"
  return path.split('/').pop()!.replace(/\.tsx$/, '').replace(/^\d+-/, '');
}

export const EXAMPLES: Example[] = Object.keys(modules)
  .sort()
  .map((path) => {
    const mod = modules[path]!;
    return {
      id: slug(path),
      ...mod.meta,
      Component: mod.default,
      source: sources[path] ?? '',
    };
  });

export function findExample(id: string): Example | undefined {
  return EXAMPLES.find((example) => example.id === id);
}
