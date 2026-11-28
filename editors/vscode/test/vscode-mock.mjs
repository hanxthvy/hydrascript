// [xihanzu-NR]
/**
 * The smallest fake `vscode` the extension actually touches.
 *
 * The alternative is an Electron download and a visible window in CI, for a
 * test whose job is "does activation wire up the providers and publish a
 * diagnostic". Every class here is a data holder; the behaviour under test is
 * in extension.js, and it is driven against the REAL compiler.
 */

export function createMockVscode() {
  const commands = new Map();
  const providers = { hover: [], definition: [], rename: [], completion: [], signature: [] };
  const collections = new Map();
  const statusBar = [];
  const output = [];
  const terminals = [];
  const messages = [];

  class Uri {
    constructor(fsPath) {
      this.fsPath = fsPath;
      this.scheme = 'file';
    }
    toString() {
      return `file://${this.fsPath}`;
    }
    static file(fsPath) {
      return new Uri(fsPath);
    }
    static parse(value) {
      return new Uri(decodeURIComponent(String(value).replace(/^file:\/\//, '')));
    }
  }

  class Position {
    constructor(line, character) {
      this.line = line;
      this.character = character;
    }
  }

  class Range {
    constructor(startLine, startCharacter, endLine, endCharacter) {
      this.start = new Position(startLine, startCharacter);
      this.end = new Position(endLine, endCharacter);
    }
  }

  class Diagnostic {
    constructor(range, message, severity) {
      this.range = range;
      this.message = message;
      this.severity = severity;
    }
  }

  class MarkdownString {
    constructor(value) {
      this.value = value;
    }
  }

  class Hover {
    constructor(contents, range) {
      this.contents = contents;
      this.range = range;
    }
  }

  class Location {
    constructor(uri, range) {
      this.uri = uri;
      this.range = range;
    }
  }

  class WorkspaceEdit {
    constructor() {
      this.edits = [];
    }
    replace(uri, range, newText) {
      this.edits.push({ uri, range, newText });
    }
  }

  class CompletionItem {
    constructor(label, kind) {
      this.label = label;
      this.kind = kind;
    }
  }

  class CompletionList {
    constructor(items, isIncomplete) {
      this.items = items;
      this.isIncomplete = isIncomplete;
    }
  }

  class SignatureHelp {
    constructor() {
      this.signatures = [];
      this.activeSignature = 0;
      this.activeParameter = 0;
    }
  }

  class SignatureInformation {
    constructor(label, documentation) {
      this.label = label;
      this.documentation = documentation;
      this.parameters = [];
    }
  }

  class ParameterInformation {
    constructor(label, documentation) {
      this.label = label;
      this.documentation = documentation;
    }
  }

  const disposable = { dispose() {} };

  const mock = {
    registeredCommands: commands,
    providers,
    collections,
    statusBar,
    output,
    terminals,
    messages,
    documents: [],
    config: {},
    activeTextEditor: undefined,
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    CompletionItemKind: Object.fromEntries(
      [
        'Text',
        'Method',
        'Function',
        'Constructor',
        'Field',
        'Variable',
        'Class',
        'Interface',
        'Module',
        'Property',
        'Unit',
        'Value',
        'Enum',
        'Keyword',
        'Snippet',
        'Color',
        'File',
        'Reference',
        'Folder',
        'EnumMember',
        'Constant',
        'Struct',
        'Event',
        'Operator',
        'TypeParameter',
      ].map((name, index) => [name, index + 1]),
    ),
    StatusBarAlignment: { Left: 1, Right: 2 },
    Uri,
    Range,
    Position,
    Diagnostic,
    MarkdownString,
    Hover,
    Location,
    WorkspaceEdit,
    CompletionItem,
    CompletionList,
    SignatureHelp,
    SignatureInformation,
    ParameterInformation,

    languages: {
      createDiagnosticCollection(name) {
        const store = new Map();
        collections.set(name, store);
        return {
          set(uri, diagnostics) {
            store.set(uri.toString(), diagnostics);
          },
          delete(uri) {
            store.delete(uri.toString());
          },
          clear() {
            store.clear();
          },
          dispose() {},
        };
      },
      registerHoverProvider(selector, provider) {
        providers.hover.push({ selector, provider });
        return disposable;
      },
      registerDefinitionProvider(selector, provider) {
        providers.definition.push({ selector, provider });
        return disposable;
      },
      registerRenameProvider(selector, provider) {
        providers.rename.push({ selector, provider });
        return disposable;
      },
      registerCompletionItemProvider(selector, provider, ...triggers) {
        providers.completion.push({ selector, provider, triggers });
        return disposable;
      },
      registerSignatureHelpProvider(selector, provider, ...triggers) {
        providers.signature.push({ selector, provider, triggers });
        return disposable;
      },
    },

    workspace: {
      workspaceFolders: [],
      textDocuments: [],
      getConfiguration() {
        return {
          get(key, fallback) {
            return key in mock.config ? mock.config[key] : fallback;
          },
        };
      },
      onDidOpenTextDocument() {
        return disposable;
      },
      onDidChangeTextDocument() {
        return disposable;
      },
      onDidSaveTextDocument() {
        return disposable;
      },
      onDidCloseTextDocument() {
        return disposable;
      },
      onDidChangeConfiguration() {
        return disposable;
      },
      onDidCreateFiles() {
        return disposable;
      },
      async openTextDocument() {
        return undefined;
      },
    },

    window: {
      createOutputChannel(name) {
        return {
          name,
          appendLine(line) {
            output.push(line);
          },
          append(line) {
            output.push(line);
          },
          show() {},
          dispose() {},
        };
      },
      createStatusBarItem(alignment, priority) {
        const item = {
          alignment,
          priority,
          text: '',
          tooltip: undefined,
          command: undefined,
          visible: false,
          show() {
            item.visible = true;
          },
          hide() {
            item.visible = false;
          },
          dispose() {},
        };
        statusBar.push(item);
        return item;
      },
      createTerminal(options) {
        const terminal = {
          name: options?.name,
          cwd: options?.cwd,
          exitStatus: undefined,
          sent: [],
          sendText(text) {
            terminal.sent.push(text);
          },
          show() {},
          dispose() {},
        };
        terminals.push(terminal);
        return terminal;
      },
      async showInputBox() {
        return undefined;
      },
      async showTextDocument() {
        return undefined;
      },
      showWarningMessage(message) {
        messages.push(message);
      },
      showErrorMessage(message) {
        messages.push(message);
      },
      showInformationMessage(message) {
        messages.push(message);
      },
      setStatusBarMessage(message) {
        messages.push(message);
        return disposable;
      },
    },

    commands: {
      registerCommand(id, handler) {
        commands.set(id, handler);
        return disposable;
      },
    },
    env: {
      async openExternal() {
        return true;
      },
    },
  };

  return mock;
}

/** A document-shaped object, which is all the extension reads from one. */
export function mockDocument(uri, languageId, text) {
  return {
    uri,
    languageId,
    fileName: uri.fsPath,
    version: 1,
    isDirty: false,
    getText() {
      return text;
    },
  };
}
