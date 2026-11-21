// lib/codegen/index.js — Génération de code client à partir du modèle du
// store actif : TypeScript, Go, Python et un script curl.
//
// Chaque générateur reçoit la même description (spec.js) : types et
// relations avec des identifiants sûrs, store et modèle courants, et un
// exemple cohérent avec le modèle.

import { buildSpec } from './spec.js';
import { generateTypeScript } from './typescript.js';
import { generateGo } from './go.js';
import { generatePython } from './python.js';
import { generateCurl } from './curl.js';

export { normalizeTypes, subjectLabel, exprToText, relationSummaryFor } from './normalize.js';

const GENERATORS = {
  typescript: { generate: generateTypeScript, filename: 'authz.ts' },
  go: { generate: generateGo, filename: 'authz.go' },
  python: { generate: generatePython, filename: 'authz.py' },
  curl: { generate: generateCurl, filename: 'openfga.sh' },
};

/** Langages supportés, dans l'ordre des onglets. */
export function listLanguages() {
  return Object.keys(GENERATORS);
}

/** Nom de fichier proposé au téléchargement. */
export function filenameFor(language) {
  return GENERATORS[language]?.filename || 'authz.txt';
}

/**
 * Génère le code client pour le langage demandé.
 * @param {object} model     modèle OpenFGA (type_definitions) ou AST interne
 * @param {string} language  'typescript' | 'go' | 'python' | 'curl'
 * @param {object} [ctx]     { storeId, storeName, modelId, apiUrl }
 */
export function generateCode(model, language, ctx = {}) {
  const generator = GENERATORS[language];
  if (!generator) throw new Error(`Langage non supporté : ${language}`);
  return generator.generate(buildSpec(model, ctx));
}
