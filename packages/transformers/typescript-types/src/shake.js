// @flow
import {TSModule} from './TSModule';
import type {TSModuleGraph} from './TSModuleGraph';
import typeof TypeScriptModule from 'typescript';
import {getExportedName, isDeclaration} from './utils';
import nullthrows from 'nullthrows';

export function shake(
  ts: TypeScriptModule,
  moduleGraph: TSModuleGraph,
  context: any,
  sourceFile: any
) {
  // Propagate exports from the main module to determine what types should be included
  let exportedNames = moduleGraph.propagate(context);

  let currentModule: ?TSModule;
  let visit = (node: any): any => {
    if (ts.isBundle(node)) {
      return ts.updateBundle(node, ts.visitNodes(node.sourceFiles, visit));
    }

    // Flatten all module declarations into the top-level scope
    if (ts.isModuleDeclaration(node)) {
      currentModule = moduleGraph.getModule(node.name.text);
      return ts.visitEachChild(node, visit, context).body.statements;
    }

    if (!currentModule) {
      return ts.visitEachChild(node, visit, context);
    }

    // Remove imports to flattened modules
    if (ts.isImportDeclaration(node)) {
      if (moduleGraph.getModule(node.moduleSpecifier.text)) {
        return null;
      }

      return node;
    }

    // Remove exports from flattened modules
    if (ts.isExportDeclaration(node)) {
      if (
        !node.moduleSpecifier ||
        moduleGraph.getModule(node.moduleSpecifier.text)
      ) {
        return null;
      }
    }

    if (isDeclaration(ts, node)) {
      let name = getExportedName(ts, node) || node.name.text;

      // Remove unused declarations
      if (!currentModule.used.has(name)) {
        return null;
      }

      // Remove original export modifiers
      node = ts.getMutableClone(node);
      node.modifiers = (node.modifiers || []).filter(
        m =>
          m.kind !== ts.SyntaxKind.ExportKeyword &&
          m.kind !== ts.SyntaxKind.DefaultKeyword
      );

      // Rename declarations
      let newName = currentModule.names.get(name) || name;
      if (newName !== name && newName !== 'default') {
        node.name = ts.createIdentifier(newName);
      }

      // Export declarations that should be exported
      if (exportedNames.get(newName) === currentModule) {
        if (newName === 'default') {
          node.modifiers.unshift(
            ts.createModifier(ts.SyntaxKind.DefaultKeyword)
          );
        }

        node.modifiers.unshift(ts.createModifier(ts.SyntaxKind.ExportKeyword));
      }
    }

    if (ts.isVariableStatement(node)) {
      node = ts.visitEachChild(node, visit, context);

      // Remove empty variable statements
      if (node.declarationList.declarations.length === 0) {
        return null;
      }

      // Remove original export modifiers
      node.modifiers = (node.modifiers || []).filter(
        m => m.kind !== ts.SyntaxKind.ExportKeyword
      );

      // Add export modifier if all declarations are exported.
      let isExported = node.declarationList.declarations.every(
        d => exportedNames.get(d.name.text) === currentModule
      );
      if (isExported) {
        node.modifiers.unshift(ts.createModifier(ts.SyntaxKind.ExportKeyword));
      }

      return node;
    }

    if (ts.isVariableDeclaration(node)) {
      // Remove unused variables
      if (!currentModule.used.has(node.name.text)) {
        return null;
      }
    }

    // Rename references
    if (ts.isIdentifier(node) && currentModule.names.has(node.text)) {
      return ts.createIdentifier(
        nullthrows(currentModule.names.get(node.text))
      );
    }

    // Replace namespace references with final names
    if (ts.isQualifiedName(node) && ts.isIdentifier(node.left)) {
      let resolved = moduleGraph.resolveImport(
        currentModule,
        node.left.text,
        node.right.text
      );
      if (resolved) {
        return ts.createIdentifier(resolved.name);
      }
    }

    return ts.visitEachChild(node, visit, context);
  };

  return ts.visitNode(sourceFile, visit);
}