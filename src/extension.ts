import {
  ExtensionContext,
  languages,
  commands,
  workspace,
  TextDocument,
  Range,
  TextEdit,
  Position,
  window,
} from 'coc.nvim';
import {
  Rubocop,
  RubocopAutocorrectProvider,
  RubocopCodeActionProvider,
} from './rubocop';
import { onDidChangeConfiguration } from './configuration';

// entry point of extension
export function activate(context: ExtensionContext): void {
  'use strict';

  const diag = languages.createDiagnosticCollection('ruby');
  context.subscriptions.push(diag);

  const rubocop = new Rubocop(diag);

  context.subscriptions.push(
    commands.registerCommand('ruby.rubocop', async () => {
      const document = await workspace.document;
      rubocop.execute(document.textDocument);
    }),
    commands.registerCommand(
      'ruby.rubocop.ignore.inline',
      async (copName: string, range: Range) => {
        const document = await workspace.document;
        const edits: TextEdit[] = [];
        window.showMessage(JSON.stringify(range));
        for (let l = range.start.line; l <= range.end.line; l++) {
          const line = document.getline(l);
          let appendLine: string;
          if (
            /.*#\s*rubocop:disable [A-Za-z\/]+\s*([A-Za-z\/]+,\s*)*/.test(line)
          ) {
            appendLine = `, ${copName}`;
          } else {
            appendLine = ` # rubocop:disable ${copName}`;
          }
          edits.push(
            TextEdit.insert(Position.create(l, line.length), appendLine),
          );
        }
        await document.applyEdits(edits);
      },
    ),
    commands.registerCommand(
      'ruby.rubocop.ignore.wrap',
      async (copName: string, range: Range) => {
        const document = await workspace.document;
        const edits = [
          TextEdit.insert(
            Position.create(range.start.line, 0),
            `# rubocop:disable ${copName}\n`,
          ),
          TextEdit.insert(
            Position.create(range.end.line + 1, -1),
            `# rubocop:enable ${copName}\n`,
          ),
        ];
        await document.applyEdits(edits);
      },
    ),
  );

  workspace.onDidChangeConfiguration(onDidChangeConfiguration(rubocop));

  workspace.textDocuments.forEach((e: TextDocument) => {
    rubocop.execute(e);
  });

  workspace.onDidOpenTextDocument((e: TextDocument) => {
    rubocop.execute(e);
  });

  workspace.onDidSaveTextDocument((e: TextDocument) => {
    if (rubocop.isOnSave) {
      rubocop.execute(e);
    }
  });

  workspace.onDidCloseTextDocument((e: TextDocument) => {
    rubocop.clear(e);
  });
  const formattingProvider = new RubocopAutocorrectProvider();
  languages.registerDocumentFormatProvider(['ruby'], formattingProvider);
  const codeActionProvider = new RubocopCodeActionProvider(rubocop);
  languages.registerCodeActionProvider(['ruby'], codeActionProvider, undefined);
}
