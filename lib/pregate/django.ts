/**
 * pregate/django — the edges Django creates by name rather than by import
 * (#3266). The import graph follows Python imports, but Django loads much of
 * a project from settings strings and directory conventions, so without these
 * edges a migration, an admin module or a template has no test lane.
 *
 * A repo is a Django project when it carries Django evidence (a manage.py, or
 * Python code that imports django) and a settings module: Python code (strings
 * and comments excluded) that assigns INSTALLED_APPS or ROOT_URLCONF, or the
 * module a config file names in DJANGO_SETTINGS_MODULE. Then:
 *   - every Python test depends on each settings module (the test runner
 *     loads it), so a settings change selects the suite;
 *   - a dotted string in a settings module (`"stores.backends.StoreOwnerBackend"`,
 *     ROOT_URLCONF) and an `include("app.urls")` argument anywhere count as
 *     imports of the module they name;
 *   - an app (a directory holding apps.py, models.py or migrations/) maps its
 *     migrations, admin, templates, static files, template tags, management
 *     commands, fixtures and locale files to that app's tests and to the tests
 *     that reach its models, as an edit to models.py does; an app with no tests
 *     of its own falls back to the settings module (the suite);
 *   - a template under a project-level templates/ directory (settings DIRS)
 *     maps to the settings module: conservatively the whole suite.
 * Uncertainty widens the selection; nothing here removes an edge.
 */
import * as path from 'node:path';

export interface DjangoInput {
  files: readonly string[];
  tests: ReadonlySet<string>;
  read: (rel: string) => string | null;
  /** Python source with strings blanked and comments dropped. */
  code: (source: string) => string;
  /** A dotted Python name → the repo files of its longest module prefix ([] outside the repo). */
  resolveDotted: (dotted: string) => string[];
}

/** One edge: `dependent` depends on `dependency`. */
export interface DjangoEdge { dependency: string; dependent: string }

const SETTINGS_ASSIGN = /^(?:INSTALLED_APPS|ROOT_URLCONF)[ \t]*(?::[^=\n]*)?[+]?=/m;
const IMPORTS_DJANGO = /^[ \t]*(?:from[ \t]+django[\w.]*[ \t]+import|import[ \t]+django\b)/m;
const SETTINGS_ENV = /DJANGO_SETTINGS_MODULE['"]?\s*[,=:]\s*['"]?([A-Za-z_][\w.]*)/g;
const SETTINGS_ENV_FILES = /(?:^|\/)(?:manage\.py|pytest\.ini|pyproject\.toml|setup\.cfg|tox\.ini|conftest\.py|\.env\.example)$/;
const DOTTED_STRING = /['"]([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+)['"]/g;
const INCLUDE = /\binclude\(\s*['"]([A-Za-z_][\w.]*)['"]/g;
/** Paths inside an app that Django loads by convention, relative to the app directory. */
const SOURCE_LIKE = /\.(?:py|[cm]?[jt]sx?)$/;
const APP_LOADED = /^(?:migrations\/.+\.py|admin\.py|admin\/.+|templates\/.+|jinja2\/.+|static\/.+|templatetags\/.+|management\/.+|fixtures\/.+|locale\/.+)$/;

function settingsModules(input: DjangoInput): string[] {
  const out = new Set<string>();
  let evidence = input.files.some(f => /(?:^|\/)manage\.py$/.test(f));
  for (const f of input.files) {
    if (f.endsWith('.py')) {
      const text = input.read(f);
      const code = text ? input.code(text) : '';
      if (SETTINGS_ASSIGN.test(code)) out.add(f);
      if (!evidence && IMPORTS_DJANGO.test(code)) evidence = true;
    }
    if (!SETTINGS_ENV_FILES.test(f)) continue;
    const text = input.read(f) ?? '';
    for (const m of text.matchAll(SETTINGS_ENV)) for (const t of input.resolveDotted(m[1]!)) if (t.endsWith('.py') && !t.endsWith('/__init__.py')) out.add(t);
  }
  return evidence ? [...out].sort() : [];
}

/** App directories: a directory holding apps.py, models.py, models/__init__.py or migrations/__init__.py. */
function appDirs(files: readonly string[]): string[] {
  const out = new Set<string>();
  for (const f of files) {
    const m = /^(?:(.*)\/)?(?:apps\.py|models\.py|models\/__init__\.py|migrations\/__init__\.py)$/.exec(f);
    if (m && m[1] !== undefined && !/(?:^|\/)(?:migrations|models)$/.test(m[1])) out.add(m[1]);
  }
  return [...out].sort((a, b) => b.length - a.length);
}

export function djangoEdges(input: DjangoInput): DjangoEdge[] {
  const settings = settingsModules(input);
  if (!settings.length) return [];
  const edges: DjangoEdge[] = [];
  const has = new Set(input.files);
  const pyTests = [...input.tests].filter(t => t.endsWith('.py'));
  for (const s of settings) {
    for (const t of pyTests) edges.push({ dependency: s, dependent: t });
    for (const m of (input.read(s) ?? '').matchAll(DOTTED_STRING)) for (const t of input.resolveDotted(m[1]!)) edges.push({ dependency: t, dependent: s });
  }
  for (const f of input.files) {
    if (!f.endsWith('.py') || input.tests.has(f)) continue;
    const text = input.read(f);
    if (!text || !text.includes('include(')) continue;
    for (const m of text.matchAll(INCLUDE)) for (const t of input.resolveDotted(m[1]!)) edges.push({ dependency: t, dependent: f });
  }
  const apps = appDirs(input.files);
  const appOf = (f: string) => apps.find(a => f.startsWith(`${a}/`));
  const appTests = new Map(apps.map(a => [a, pyTests.filter(t => appOf(t) === a)]));
  for (const f of input.files) {
    if (input.tests.has(f)) continue;
    const app = appOf(f);
    const rel = app === undefined ? null : f.slice(app.length + 1);
    if (app !== undefined && rel !== null && APP_LOADED.test(rel)) {
      const anchor = [`${app}/models.py`, `${app}/models/__init__.py`].find(a => has.has(a));
      if (anchor && anchor !== f) edges.push({ dependency: f, dependent: anchor });
      const own = appTests.get(app)!;
      for (const t of own) edges.push({ dependency: f, dependent: t });
      if (!own.length) for (const s of settings) edges.push({ dependency: f, dependent: s });
      continue;
    }
    if (/(?:^|\/)templates\/./.test(f) && !SOURCE_LIKE.test(path.posix.basename(f))) for (const s of settings) edges.push({ dependency: f, dependent: s });
  }
  return edges;
}
