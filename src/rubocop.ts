import { CodeActionKind } from 'vscode-languageserver-types';
import {
  RubocopOutput,
  RubocopFile,
  RubocopOffense,
  RubocopCodeActionRange,
} from './rubocopOutput';
import { TaskQueue, Task } from './taskQueue';
import cp from 'child_process';
import fs from 'fs';
import pathLib from 'path';
import {
  DocumentFormattingEditProvider,
  TextDocument,
  window,
  TextEdit,
  Range,
  Position,
  Uri,
  workspace,
  DiagnosticCollection,
  Diagnostic,
  DiagnosticSeverity,
  CodeActionProvider,
  CodeAction,
} from 'coc.nvim';
import { getConfig, RubocopConfig } from './configuration';

export class RubocopAutocorrectProvider
  implements DocumentFormattingEditProvider {
  public provideDocumentFormattingEdits(document: TextDocument): TextEdit[] {
    const config = getConfig();
    const filename = pathLib.dirname(document.uri);
    try {
      const args = [...getCommandArguments(filename), '--auto-correct'];
      const options = {
        cwd: getCurrentPath(filename),
        input: document.getText(),
      };
      let stdout;
      if (config.useBundler) {
        stdout = cp.execSync(`${config.command} ${args.join(' ')}`, options);
      } else {
        stdout = cp.execFileSync(config.command, args, options);
      }

      return this.onSuccess(document, stdout);
    } catch (e) {
      // if there are still some offences not fixed RuboCop will return status 1
      if (e.status !== 1) {
        void window.showWarningMessage(
          'An error occurred during auto-correction',
        );
        // eslint-disable-next-line no-console
        console.log(e);
        return [];
      } else {
        return this.onSuccess(document, e.stdout);
      }
    }
  }

  // Output of auto-correction looks like this:
  //
  // {"metadata": ... {"offense_count":5,"target_file_count":1,"inspected_file_count":1}}====================
  // def a
  //   3
  // end
  //
  // So we need to parse out the actual auto-corrected ruby
  private onSuccess(document: TextDocument, stdout: Buffer) {
    const stringOut = stdout.toString();
    const autoCorrection = stringOut.match(
      /^.*\n====================(?:\n|\r\n)([.\s\S]*)/m,
    );
    if (!autoCorrection) {
      throw new Error(`Error parsing auto-correction from CLI: ${stringOut}`);
    }
    return [
      TextEdit.replace(this.getFullRange(document), autoCorrection.pop()!),
    ];
  }

  private getFullRange(document: TextDocument): Range {
    return Range.create(
      Position.create(0, 0),
      Position.create(document.lineCount, 0),
    );
  }
}

function inRange(range: Range, pos: Position) {
  const { start, end } = range;
  return (
    start.line <= pos.line &&
    start.character <= pos.character &&
    end.line >= pos.line &&
    end.character >= pos.character
  );
}

export class RubocopCodeActionProvider implements CodeActionProvider {
  constructor(public readonly rubocop: Rubocop) {}

  provideCodeActions(document: TextDocument, cursorRange: Range): CodeAction[] {
    const actions = this.rubocop.actionsMap.get(document.uri);
    if (!actions) {
      return [];
    }
    const codeActions: CodeAction[] = [];
    for (const a of actions) {
      if (
        inRange(a.range, cursorRange.start) ||
        inRange(a.range, cursorRange.end)
      ) {
        codeActions.push(...a.actions);
      }
    }
    return codeActions;
  }
}

function isFileUri(path: string): boolean {
  const uri = Uri.parse(path);
  return uri.scheme === 'file';
}

function getCurrentPath(fileName: string): string {
  return workspace.rootPath || pathLib.dirname(fileName);
}

// extract argument to an array
function getCommandArguments(fileName: string): string[] {
  let commandArguments = ['--stdin', fileName, '--force-exclusion'];
  const extensionConfig = getConfig();
  if (extensionConfig.configFilePath !== '') {
    const found = [extensionConfig.configFilePath]
      .concat(
        (workspace.workspaceFolders || []).map((ws: any) =>
          pathLib.join(ws.uri.path, extensionConfig.configFilePath),
        ),
      )
      .filter((p: string) => fs.existsSync(p));

    if (found.length === 0) {
      void window.showWarningMessage(
        `${extensionConfig.configFilePath} file does not exist. Ignoring...`,
      );
    } else {
      if (found.length > 1) {
        void window.showWarningMessage(
          `Found multiple files (${found}) will use ${found[0]}`,
        );
      }
      const config = ['--config', found[0]];
      commandArguments = commandArguments.concat(config);
    }
  }

  return commandArguments;
}

function createCodeAction(
  title: string,
  copName: string,
  command: string,
  range: Range,
  diagnostics: Diagnostic[],
): CodeAction {
  return {
    title,
    kind: CodeActionKind.QuickFix,
    command: {
      command,
      title,
      arguments: [copName, range],
    },
    diagnostics,
  };
}

export class Rubocop {
  public config: RubocopConfig;
  public actionsMap: Map<string, RubocopCodeActionRange[]> = new Map();
  private diag: DiagnosticCollection;
  private additionalArguments: string[];
  private taskQueue: TaskQueue = new TaskQueue();

  constructor(
    diagnostics: DiagnosticCollection,
    additionalArguments: string[] = [],
  ) {
    this.diag = diagnostics;
    this.additionalArguments = additionalArguments;
    this.config = getConfig();
  }

  public execute(document: TextDocument, onComplete?: () => void): void {
    if (
      (document.languageId !== 'ruby') ||
      !isFileUri(document.uri)
    ) {
      // git diff has ruby-mode. but it is Untitled file.
      return;
    }

    const filename = pathLib.dirname(document.uri);
    const uri = document.uri;
    const currentPath = getCurrentPath(filename);

    const onDidExec = (
      error: Error | undefined,
      stdout: string,
      stderr: string,
    ) => {
      this.reportError(error, stderr);
      const rubocop = this.parse(stdout);
      if (rubocop === undefined) {
        return;
      }

      this.diag.delete(uri);
      this.actionsMap.delete(uri);

      const entries: [string, Diagnostic[]][] = [];
      const actions: RubocopCodeActionRange[] = [];
      rubocop.files.forEach((file: RubocopFile) => {
        const diagnostics: Diagnostic[] = [];
        file.offenses.forEach((offence: RubocopOffense) => {
          const loc = offence.location;
          const range = Range.create(
            loc.line - 1,
            loc.column - 1,
            loc.line - 1,
            loc.length + loc.column - 1,
          );
          const sev = this.severity(offence.severity);
          const message = `${offence.message} (${offence.severity}:${offence.cop_name})`;
          const diagnostic = Diagnostic.create(range, message, sev);
          diagnostics.push(diagnostic);
          const action: RubocopCodeActionRange = {
            range,
            actions: [
              createCodeAction(
                `ignore inline (${offence.cop_name})`,
                offence.cop_name,
                'ruby.rubocop.ignore.inline',
                range,
                diagnostics,
              ),
              createCodeAction(
                `ignore wrap (${offence.cop_name})`,
                offence.cop_name,
                'ruby.rubocop.ignore.wrap',
                range,
                diagnostics,
              ),
            ],
          };
          actions.push(action);
        });
        entries.push([uri, diagnostics]);
      });

      this.diag.set(entries);
      this.actionsMap.set(uri, actions);
    };

    const jsonOutputFormat = ['--format', 'json'];
    const args = getCommandArguments(filename)
      .concat(this.additionalArguments)
      .concat(jsonOutputFormat);

    const task = new Task(uri, (token) => {
      const process = this.executeRubocop(
        args,
        document.getText(),
        { cwd: currentPath },
        (error, stdout, stderr) => {
          if (token.isCanceled) {
            return;
          }
          onDidExec(error ?? undefined, stdout, stderr);
          token.finished();
          if (onComplete) {
            onComplete();
          }
        },
      );
      return () => process.kill();
    });
    this.taskQueue.enqueue(task);
  }

  public get isOnSave(): boolean {
    return this.config.onSave;
  }

  public clear(document: TextDocument): void {
    const uri = document.uri;
    if (isFileUri(uri)) {
      this.taskQueue.cancel(uri);
      this.diag.delete(uri);
    }
  }

  // execute rubocop
  private executeRubocop(
    args: string[],
    fileContents: string,
    options: cp.ExecOptions,
    cb: (err: Error | null, stdout: string, stderr: string) => void,
  ): cp.ChildProcess {
    let child;
    if (this.config.useBundler) {
      child = cp.exec(`${this.config.command} ${args.join(' ')}`, options, cb);
    } else {
      child = cp.execFile(this.config.command, args, options, cb);
    }
    child.stdin?.write(fileContents);
    child.stdin?.end();
    return child;
  }

  // parse rubocop(JSON) output
  private parse(output: string): RubocopOutput | undefined {
    if (output.length < 1) {
      const message = `command ${this.config.command} returns empty output! please check configuration.`;
      void window.showWarningMessage(message);

      return;
    }

    try {
      return JSON.parse(output);
    } catch (e) {
      if (e instanceof SyntaxError) {
        const regex = /[\r\n \t]/g;
        const message = output.replace(regex, ' ');
        const errorMessage = `Error on parsing output (It might non-JSON output) : "${message}"`;
        void window.showWarningMessage(errorMessage);
      }
    }
  }

  // checking rubocop output has error
  private reportError(error: Error | undefined, stderr: string): boolean {
    const errorOutput = stderr.toString();
    if (error && (<any>error).code === 'ENOENT') {
      void window.showWarningMessage(
        `${this.config.command} is not executable`,
      );
      return true;
    } else if (error && (<any>error).code === 127) {
      void window.showWarningMessage(stderr);
      return true;
    } else if (errorOutput.length > 0 && !this.config.suppressRubocopWarnings) {
      void window.showWarningMessage(stderr);
      return true;
    }

    return false;
  }

  private severity(sev: string): DiagnosticSeverity {
    switch (sev) {
      case 'refactor':
        return DiagnosticSeverity.Hint;
      case 'convention':
        return DiagnosticSeverity.Information;
      case 'warning':
        return DiagnosticSeverity.Warning;
      case 'error':
        return DiagnosticSeverity.Error;
      case 'fatal':
        return DiagnosticSeverity.Error;
      default:
        return DiagnosticSeverity.Error;
    }
  }
}
