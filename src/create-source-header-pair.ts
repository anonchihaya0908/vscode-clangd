import * as path from 'path';
import * as vscode from 'vscode';

import { ClangdContext } from './clangd-context';
import { PairingRule, PairingRuleService } from './pairing-rule-manager';

// Types for better type safety
type Language = 'c' | 'cpp';
type TemplateKey = 'CPP_CLASS' | 'CPP_STRUCT' | 'C_STRUCT' | 'C_EMPTY' | 'CPP_EMPTY';

// Regular expression pattern to validate C/C++ identifiers
const VALIDATION_PATTERNS = {
  IDENTIFIER: /^[a-zA-Z_][a-zA-Z0-9_]*$/
} as const;

// Default placeholder names for different file types
const DEFAULT_PLACEHOLDERS = {
  C_EMPTY: 'my_c_functions',
  C_STRUCT: 'MyStruct',
  CPP_EMPTY: 'utils',
  CPP_CLASS: 'MyClass',
  CPP_STRUCT: 'MyStruct'
} as const;

// Template rules for available file pair types
const TEMPLATE_RULES: readonly PairingRule[] = Object.freeze([
  Object.freeze({
    key: 'cpp_empty',
    label: '$(new-file) C++ Pair',
    description: 'Creates a basic Header/Source file pair with header guards.',
    language: 'cpp' as const,
    headerExt: '.h',
    sourceExt: '.cpp'
  }),
  Object.freeze({
    key: 'cpp_class',
    label: '$(symbol-class) C++ Class',
    description:
      'Creates a Header/Source file pair with a boilerplate class definition.',
    language: 'cpp' as const,
    headerExt: '.h',
    sourceExt: '.cpp',
    isClass: true
  }),
  Object.freeze({
    key: 'cpp_struct',
    label: '$(symbol-struct) C++ Struct',
    description:
      'Creates a Header/Source file pair with a boilerplate struct definition.',
    language: 'cpp' as const,
    headerExt: '.h',
    sourceExt: '.cpp',
    isStruct: true
  }),
  Object.freeze({
    key: 'c_empty',
    label: '$(file-code) C Pair',
    description: 'Creates a basic .h/.c file pair for function declarations.',
    language: 'c' as const,
    headerExt: '.h',
    sourceExt: '.c'
  }),
  Object.freeze({
    key: 'c_struct',
    label: '$(symbol-struct) C Struct',
    description: 'Creates a .h/.c file pair with a boilerplate typedef struct.',
    language: 'c' as const,
    headerExt: '.h',
    sourceExt: '.c',
    isStruct: true
  })
]);

// File templates with immutable structure
const FILE_TEMPLATES = Object.freeze({
  CPP_CLASS: Object.freeze({
    header: `#ifndef {{headerGuard}}
#define {{headerGuard}}

class {{fileName}} {
public:
  {{fileName}}();
  ~{{fileName}}();

private:
  // Add private members here
};

#endif  // {{headerGuard}}
`,
    source: `{{includeLine}}

{{fileName}}::{{fileName}}() {
  // Constructor implementation
}

{{fileName}}::~{{fileName}}() {
  // Destructor implementation
}
`
  }),
  CPP_STRUCT: Object.freeze({
    header: `#ifndef {{headerGuard}}
#define {{headerGuard}}

struct {{fileName}} {
  // Struct members
};

#endif  // {{headerGuard}}
`,
    source: '{{includeLine}}'
  }),
  C_STRUCT: Object.freeze({
    header: `#ifndef {{headerGuard}}
#define {{headerGuard}}

typedef struct {
  // Struct members
} {{fileName}};

#endif  // {{headerGuard}}
`,
    source: '{{includeLine}}'
  }),
  C_EMPTY: Object.freeze({
    header: `#ifndef {{headerGuard}}
#define {{headerGuard}}

// Declarations for {{fileName}}.c

#endif  // {{headerGuard}}
`,
    source: `{{includeLine}}

// Implementations for {{fileName}}.c
`
  }),
  CPP_EMPTY: Object.freeze({
    header: `#ifndef {{headerGuard}}
#define {{headerGuard}}

// Declarations for {{fileName}}.cpp

#endif  // {{headerGuard}}
`,
    source: '{{includeLine}}'
  })
} as const);

// Service Layer - Core business logic
class PairCreatorService {
  // Cache for expensive file system operations
  private static readonly fileStatCache = new Map<string, Promise<boolean>>();

  // Definitive file extensions for fast lookup
  private static readonly DEFINITIVE_EXTENSIONS = Object.freeze({
    c: new Set(['.c']),
    cpp: new Set(['.cpp', '.cc', '.cxx', '.hh', '.hpp', '.hxx'])
  });

  // Clear cache when needed (e.g., when files change)
  private static clearCache(): void {
    this.fileStatCache.clear();
  }

  // Optimized file existence check with caching
  private static async fileExists(filePath: string): Promise<boolean> {
    if (this.fileStatCache.has(filePath)) {
      return this.fileStatCache.get(filePath)!;
    }

    const promise = Promise.resolve(
      vscode.workspace.fs.stat(vscode.Uri.file(filePath))
        .then(() => true, () => false)
    );

    this.fileStatCache.set(filePath, promise);

    // Auto-clear cache entry after 5 seconds to prevent memory leaks
    setTimeout(() => this.fileStatCache.delete(filePath), 5000);

    return promise;
  }

  /** Detects programming language with optimized logic */
  public async detectLanguage(): Promise<{ language: Language, uncertain: boolean }> {
    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor?.document || activeEditor.document.isUntitled) {
      return { language: 'cpp', uncertain: true };
    }

    const { languageId, uri: { fsPath } } = activeEditor.document;
    const ext = path.extname(fsPath);

    // Fast path for definitive extensions
    if (PairCreatorService.DEFINITIVE_EXTENSIONS.c.has(ext)) {
      return { language: 'c', uncertain: false };
    }
    if (PairCreatorService.DEFINITIVE_EXTENSIONS.cpp.has(ext)) {
      return { language: 'cpp', uncertain: false };
    }

    // Special handling for .h files with companion file detection
    if (ext === '.h') {
      const result = await this.detectLanguageForHeaderFile(fsPath);
      if (result) return result;
    }

    // Fallback to VS Code language detection
    return { language: languageId === 'c' ? 'c' : 'cpp', uncertain: true };
  }

  /** Optimized header file language detection */
  private async detectLanguageForHeaderFile(filePath: string): Promise<{ language: Language, uncertain: boolean } | null> {
    const baseName = path.basename(filePath, '.h');
    const dirPath = path.dirname(filePath);

    // Check for C companion file first (less common, check first for early exit)
    const cFile = path.join(dirPath, `${baseName}.c`);
    if (await PairCreatorService.fileExists(cFile)) {
      return { language: 'c', uncertain: false };
    }

    // Check for C++ companion files in parallel
    const cppExtensions = ['.cpp', '.cc', '.cxx'];
    const cppChecks = cppExtensions.map(ext =>
      PairCreatorService.fileExists(path.join(dirPath, `${baseName}${ext}`))
    );

    const results = await Promise.all(cppChecks);
    if (results.some(exists => exists)) {
      return { language: 'cpp', uncertain: false };
    }

    return { language: 'cpp', uncertain: true };
  }

  /** Adapts template rules with improved performance */
  public adaptRuleForCurrentExtensions(rule: PairingRule, detectedLanguage: Language): PairingRule {
    if (rule.language !== 'cpp') return rule;

    // Use nullish coalescing for cleaner code
    const allRules = [
      ...(PairingRuleService.getRules('workspace') ?? []),
      ...(PairingRuleService.getRules('user') ?? [])
    ];

    const cppCustomRule = allRules.find(r => r.language === 'cpp');
    if (!cppCustomRule) return rule;

    const { headerExt, sourceExt } = cppCustomRule;

    // Use more efficient string replacement with proper typing
    const replacementPattern = /Header\/Source|\.h(?:h|pp|xx)?\/\.c(?:pp|c|xx)?/g;
    const newDescription = rule.description.replace(replacementPattern, `${headerExt}/${sourceExt}`);

    return { ...rule, description: newDescription, headerExt, sourceExt };
  }

  /** Converts string to PascalCase efficiently */
  public toPascalCase(input: string): string {
    return input
      .split(/[-_]+/)
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join('');
  }

  /** Gets placeholder name with caching for active file */
  public getPlaceholder(rule: PairingRule): string {
    const activeEditor = vscode.window.activeTextEditor;

    if (activeEditor?.document && !activeEditor.document.isUntitled) {
      const fileName = path.basename(
        activeEditor.document.fileName,
        path.extname(activeEditor.document.fileName)
      );
      return rule.language === 'c' ? fileName : this.toPascalCase(fileName);
    }

    // Use conditional logic for defaults instead of lookup table
    if (rule.isClass) {
      return DEFAULT_PLACEHOLDERS.CPP_CLASS;
    }

    if (rule.isStruct) {
      return rule.language === 'cpp'
        ? DEFAULT_PLACEHOLDERS.CPP_STRUCT
        : DEFAULT_PLACEHOLDERS.C_STRUCT;
    }

    return rule.language === 'c'
      ? DEFAULT_PLACEHOLDERS.C_EMPTY
      : DEFAULT_PLACEHOLDERS.CPP_EMPTY;
  }

  /** Optimized line ending detection */
  public getLineEnding(): string {
    const eolSetting = vscode.workspace.getConfiguration('files').get<string>('eol');

    return eolSetting === '\n' || eolSetting === '\r\n'
      ? eolSetting
      : process.platform === 'win32' ? '\r\n' : '\n';
  }

  /** Generates file content with improved template selection */
  public generateFileContent(fileName: string, eol: string, rule: PairingRule): {
    headerContent: string;
    sourceContent: string;
  } {
    const templateKey: TemplateKey = rule.isClass ? 'CPP_CLASS'
      : rule.isStruct ? (rule.language === 'cpp' ? 'CPP_STRUCT' : 'C_STRUCT')
        : rule.language === 'c' ? 'C_EMPTY' : 'CPP_EMPTY';

    const templates = FILE_TEMPLATES[templateKey];
    const context = Object.freeze({
      fileName,
      headerGuard: `${fileName.toUpperCase()}_H_`,
      includeLine: `#include "${fileName}${rule.headerExt}"`
    });

    const headerContent = this.applyTemplate(templates.header, context);
    const sourceContent = this.applyTemplate(templates.source, context);

    return {
      headerContent: headerContent.replace(/\n/g, eol),
      sourceContent: sourceContent.replace(/\n/g, eol)
    };
  }

  /** Optimized template variable substitution */
  private applyTemplate(template: string, context: Record<string, string>): string {
    // Pre-compile regex for better performance if used frequently
    return template.replace(/\{\{(\w+)\}\}/g, (_, key) => context[key] ?? '');
  }

  /** File existence check with parallel processing */
  public async checkFileExistence(headerPath: vscode.Uri, sourcePath: vscode.Uri): Promise<string | null> {
    const checks = [headerPath, sourcePath].map(async (uri) => {
      try {
        await vscode.workspace.fs.stat(uri);
        return uri.fsPath;
      } catch {
        return null;
      }
    });

    const results = await Promise.all(checks);
    return results.find(path => path !== null) ?? null;
  }

  /** Optimized file writing with error handling */
  public async writeFiles(
    headerPath: vscode.Uri,
    sourcePath: vscode.Uri,
    headerContent: string,
    sourceContent: string
  ): Promise<void> {
    try {
      await Promise.all([
        vscode.workspace.fs.writeFile(headerPath, Buffer.from(headerContent, 'utf8')),
        vscode.workspace.fs.writeFile(sourcePath, Buffer.from(sourceContent, 'utf8'))
      ]);
    } catch (error) {
      throw new Error(`Failed to create files: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /** Smart target directory detection */
  public async getTargetDirectory(): Promise<vscode.Uri | undefined> {
    const activeEditor = vscode.window.activeTextEditor;

    // Prefer current file's directory
    if (activeEditor?.document && !activeEditor.document.isUntitled) {
      return vscode.Uri.file(path.dirname(activeEditor.document.uri.fsPath));
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;

    // Return single workspace folder directly
    if (workspaceFolders?.length === 1) {
      return workspaceFolders[0].uri;
    }

    // Let user choose from multiple workspace folders
    if (workspaceFolders && workspaceFolders.length > 1) {
      const selected = await vscode.window.showWorkspaceFolderPick({
        placeHolder: 'Select workspace folder for new files'
      });
      return selected?.uri;
    }

    return undefined;
  }

  /** Optimized language mismatch warning logic */
  public async shouldShowLanguageMismatchWarning(language: Language, result: PairingRule): Promise<boolean> {
    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor?.document || activeEditor.document.isUntitled) {
      return true;
    }

    const currentDir = path.dirname(activeEditor.document.uri.fsPath);

    if (language === 'c' && result.language === 'cpp') {
      return this.checkForCppFilesInDirectory(currentDir);
    }

    return this.checkForCorrespondingSourceFiles(currentDir, activeEditor.document.uri.fsPath, language);
  }

  /** Check for C++ files in directory */
  private async checkForCppFilesInDirectory(dirPath: string): Promise<boolean> {
    try {
      const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dirPath));
      const hasCppFiles = entries.some(([fileName, fileType]) =>
        fileType === vscode.FileType.File &&
        PairCreatorService.DEFINITIVE_EXTENSIONS.cpp.has(path.extname(fileName))
      );
      return !hasCppFiles; // Show warning if NO C++ files found
    } catch {
      return true; // Show warning if can't check
    }
  }

  /** Check for corresponding source files */
  private async checkForCorrespondingSourceFiles(dirPath: string, filePath: string, language: Language): Promise<boolean> {
    const baseName = path.basename(filePath, path.extname(filePath));
    const extensions = language === 'c' ? ['.c'] : ['.cpp', '.cc', '.cxx'];

    const checks = extensions.map(ext =>
      PairCreatorService.fileExists(path.join(dirPath, `${baseName}${ext}`))
    );

    try {
      const results = await Promise.all(checks);
      return !results.some(exists => exists); // Show warning if NO corresponding files found
    } catch {
      return true; // Show warning if can't check
    }
  }
}

// UI Layer

// PairCreatorUI handles all user interface interactions for file pair creation.
// It manages dialogs, input validation, and user choices.
class PairCreatorUI {
  private service: PairCreatorService;

  constructor(service: PairCreatorService) { this.service = service; }

  // Checks for existing custom pairing rules and offers to create them if not
  // found. For C++, presents options to use custom rules or create new ones.
  // For C, always uses default templates.
  // @param language - The detected programming language
  // @param uncertain - Whether language detection was uncertain
  // @returns Selected rule, null if cancelled, undefined for defaults, or
  // 'use_default' flag
  public async checkAndOfferCustomRules(language: 'c' | 'cpp',
    uncertain: boolean):
    Promise<PairingRule | null | undefined | 'use_default'> {
    if (language === 'c')
      return undefined; // Always use default C templates

    const allRules = [
      ...(PairingRuleService.getRules('workspace') || []),
      ...(PairingRuleService.getRules('user') || [])
    ];
    const languageRules = allRules.filter(rule => rule.language === language);

    if (languageRules.length > 0) {
      const result = await this.selectFromCustomRules(languageRules, language);
      return result === undefined ? null : result;
    }

    if (!uncertain) {
      const shouldCreateRules = await this.offerToCreateCustomRules(language);
      if (shouldCreateRules === null)
        return null;
      if (shouldCreateRules) {
        const result = await this.createCustomRules(language);
        return result === undefined ? null : result;
      }
    }

    return undefined;
  }

  // Presents a selection dialog for custom pairing rules.
  // Combines custom rules with adapted default templates and cross-language
  // options.
  // @param rules - Available custom pairing rules
  // @param language - The current programming language context
  // @returns Selected rule, undefined if cancelled, or 'use_default' flag
  public async selectFromCustomRules(rules: PairingRule[], language: 'c' | 'cpp'):
    Promise<PairingRule | undefined | 'use_default'> {
    const languageRules = rules.filter(rule => rule.language === language);
    const customExt = languageRules.length > 0 ? languageRules[0] : null;

    let adaptedDefaultTemplates: PairingRule[] = [];

    if (customExt && language === 'cpp') {
      adaptedDefaultTemplates =
        TEMPLATE_RULES
          .filter(
            template =>
              template.language === 'cpp' &&
              !languageRules.some(
                customRule =>
                  customRule.isClass === template.isClass &&
                  customRule.isStruct === template.isStruct &&
                  (customRule.isClass || customRule.isStruct ||
                    (!customRule.isClass && !customRule.isStruct &&
                      !template.isClass && !template.isStruct))))
          .map(
            template => ({
              ...template,
              key: `${template.key}_adapted`,
              headerExt: customExt.headerExt,
              sourceExt: customExt.sourceExt,
              description:
                template.description
                  .replace(
                    /Header\/Source/g,
                    `${customExt.headerExt}/${customExt.sourceExt}`)
                  .replace(/\.h\/\.cpp/g, `${customExt.headerExt}/${customExt.sourceExt}`)
                  .replace(/basic \.h\/\.cpp/g,
                    `basic ${customExt.headerExt}/${customExt.sourceExt}`)
                  .replace(/Creates a \.h\/\.cpp/g,
                    `Creates a ${customExt.headerExt}/${customExt.sourceExt}`)
            }));
    } else {
      adaptedDefaultTemplates =
        TEMPLATE_RULES
          .filter(template =>
            template.language === language &&
            !languageRules.some(
              customRule =>
                customRule.headerExt === template.headerExt &&
                customRule.sourceExt === template.sourceExt &&
                customRule.isClass === template.isClass &&
                customRule.isStruct === template.isStruct))
          .map(template => this.service.adaptRuleForCurrentExtensions(
            template, language));
    }

    const otherLanguageTemplates =
      TEMPLATE_RULES.filter(template => template.language !== language)
        .map(template => this.service.adaptRuleForCurrentExtensions(
          template, language));

    const cleanedCustomRules = rules.map(
      rule => ({
        ...rule,
        label: rule.label.includes('$(')
          ? rule.label
          : `$(new-file) ${rule.language === 'cpp' ? 'C++' : 'C'} Pair (${rule.headerExt}/${rule.sourceExt})`,
        description: rule.description.startsWith('Creates a')
          ? rule.description
          : `Creates a ${rule.headerExt}/${rule.sourceExt} file pair with header guards.`
      }));

    const choices = [
      ...cleanedCustomRules, ...adaptedDefaultTemplates,
      ...otherLanguageTemplates, {
        key: 'use_default',
        label: '$(list-unordered) Use Default Templates',
        description:
          'Use the built-in default pairing rules instead of custom rules',
        isSpecial: true
      }
    ];

    const result = await vscode.window.showQuickPick(choices, {
      placeHolder: `Select a ${language.toUpperCase()} pairing rule`,
      title: 'Custom Pairing Rules Available',
    });

    if (!result)
      return undefined;
    if ('isSpecial' in result && result.isSpecial &&
      result.key === 'use_default')
      return 'use_default';
    return result as PairingRule;
  }

  // Shows a dialog offering to create custom pairing rules for C++.
  // Only applicable for C++ since C uses standard .c/.h extensions.
  // @param language - The programming language (should be 'cpp')
  // @returns true to create rules, false to dismiss, null if cancelled
  public async offerToCreateCustomRules(language: 'c' |
    'cpp'): Promise<boolean | null> {
    if (language === 'c')
      return false;

    const result = await vscode.window.showInformationMessage(
      `No custom pairing rules found for C++. Would you like to create custom rules to use different file extensions (e.g., .cc/.hh instead of .cpp/.h)?`,
      { modal: false }, 'Create Custom Rules', 'Dismiss');

    return result === 'Create Custom Rules' ? true
      : result === 'Dismiss' ? false
        : null;
  }

  // Guides the user through creating custom pairing rules for C++.
  // Offers common extension combinations or allows custom input.
  // Saves the rule to workspace or global settings.
  // @param language - The programming language (should be 'cpp')
  // @returns The created custom rule or undefined if cancelled
  public async createCustomRules(language: 'c' |
    'cpp'): Promise<PairingRule | undefined> {
    if (language === 'c')
      return undefined;

    const commonExtensions = [
      { label: '.h / .cpp (Default)', headerExt: '.h', sourceExt: '.cpp' },
      { label: '.hh / .cc (Alternative)', headerExt: '.hh', sourceExt: '.cc' }, {
        label: '.hpp / .cpp (Header Plus Plus)',
        headerExt: '.hpp',
        sourceExt: '.cpp'
      },
      { label: '.hxx / .cxx (Extended)', headerExt: '.hxx', sourceExt: '.cxx' },
      { label: 'Custom Extensions', headerExt: '', sourceExt: '' }
    ];

    const selectedExtension =
      await vscode.window.showQuickPick(commonExtensions, {
        placeHolder: `Select file extensions for C++ files`,
        title: 'Choose File Extensions'
      });

    if (!selectedExtension)
      return undefined;

    let { headerExt, sourceExt } = selectedExtension;

    if (!headerExt || !sourceExt) {
      const validateExt = (text: string) =>
        (!text || !text.startsWith('.') || text.length < 2)
          ? 'Please enter a valid file extension starting with a dot (e.g., .h)'
          : null;

      headerExt = await vscode.window.showInputBox({
        prompt: 'Enter header file extension (e.g., .h, .hh, .hpp)',
        placeHolder: '.h',
        validateInput: validateExt
      }) || '';

      if (!headerExt)
        return undefined;

      sourceExt = await vscode.window.showInputBox({
        prompt: `Enter source file extension for C++ (e.g., .cpp, .cc, .cxx)`,
        placeHolder: '.cpp',
        validateInput: validateExt
      }) || '';

      if (!sourceExt)
        return undefined;
    }

    const customRule: PairingRule = {
      key: `custom_cpp_${Date.now()}`,
      label: `$(new-file) C++ Pair (${headerExt}/${sourceExt})`,
      description:
        `Creates a ${headerExt}/${sourceExt} file pair with header guards.`,
      language: 'cpp',
      headerExt,
      sourceExt
    };

    const saveLocation = await vscode.window.showQuickPick(
      [
        {
          label: 'Workspace Settings',
          description: 'Save to current workspace only',
          value: 'workspace'
        },
        {
          label: 'Global Settings',
          description: 'Save to user settings (available in all workspaces)',
          value: 'user'
        }
      ],
      {
        placeHolder: 'Where would you like to save this custom rule?',
        title: 'Save Location'
      });

    if (!saveLocation)
      return undefined;

    try {
      const existingRules = PairingRuleService.getRules(
        saveLocation.value as 'workspace' | 'user') ||
        [];
      await PairingRuleService.writeRules([...existingRules, customRule],
        saveLocation.value as 'workspace' |
        'user');

      const locationText =
        saveLocation.value === 'workspace' ? 'workspace' : 'global';
      vscode.window.showInformationMessage(
        `Custom pairing rule saved to ${locationText} settings.`);

      return customRule;
    } catch (error: any) {
      vscode.window.showErrorMessage(
        `Failed to save custom rule: ${error.message}`);
      return undefined;
    }
  }

  // Prompts the user to select a pairing rule from available options.
  // First checks for custom rules, then falls back to default templates.
  // @param language - The detected programming language
  // @param uncertain - Whether language detection was uncertain
  // @returns Selected pairing rule or undefined if cancelled
  public async promptForPairingRule(language: 'c' | 'cpp', uncertain: boolean):
    Promise<PairingRule | undefined> {
    const customRulesResult =
      await this.checkAndOfferCustomRules(language, uncertain);

    if (customRulesResult === null)
      return undefined;
    if (customRulesResult === 'use_default') {
      // Continue to default template selection
    } else if (customRulesResult) {
      return customRulesResult;
    }

    const desiredOrder =
      uncertain
        ? ['cpp_empty', 'c_empty', 'cpp_class', 'cpp_struct', 'c_struct']
        : language === 'c'
          ? ['c_empty', 'c_struct', 'cpp_empty', 'cpp_class', 'cpp_struct']
          : ['cpp_empty', 'cpp_class', 'cpp_struct', 'c_empty', 'c_struct'];

    const choices = [...TEMPLATE_RULES]
      .sort((a, b) => desiredOrder.indexOf(a.key) -
        desiredOrder.indexOf(b.key))
      .map(rule => this.service.adaptRuleForCurrentExtensions(
        rule, language));

    const result = await vscode.window.showQuickPick(choices, {
      placeHolder: 'Please select the type of file pair to create.',
      title: 'Create Source/Header Pair'
    });

    if (result && !uncertain && language !== result.language) {
      const shouldShowWarning =
        await this.service.shouldShowLanguageMismatchWarning(language,
          result);

      if (shouldShowWarning) {
        const detectedLangName = language === 'c' ? 'C' : 'C++';
        const selectedLangName = result.language === 'c' ? 'C' : 'C++';

        const shouldContinue = await vscode.window.showWarningMessage(
          `You're working in a ${detectedLangName} file but selected a ${selectedLangName} template. This may create files with incompatible extensions or content.`,
          'Continue Anyway', 'Cancel');

        if (shouldContinue !== 'Continue Anyway')
          return undefined;
      }
    }

    return result;
  }

  // Prompts the user to enter a name for the new file pair.
  // Validates input as a valid C/C++ identifier and provides
  // context-appropriate prompts.
  // @param rule - The selected pairing rule that determines the prompt message
  // @returns The entered file name or undefined if cancelled
  public async promptForFileName(rule: PairingRule): Promise<string | undefined> {
    const prompt = rule.isClass ? 'Please enter the name for the new C++ class.'
      : rule.isStruct
        ? `Please enter the name for the new ${rule.language.toUpperCase()} struct.`
        : `Please enter the base name for the new ${rule.language.toUpperCase()} file pair.`;

    return vscode.window.showInputBox({
      prompt,
      placeHolder: this.service.getPlaceholder(rule),
      validateInput: (text) =>
        VALIDATION_PATTERNS.IDENTIFIER.test(text?.trim() || '')
          ? null
          : 'Invalid C/C++ identifier.',
      title: 'Create Source/Header Pair'
    });
  }

  // Shows success message and opens the newly created header file
  // @param headerPath - URI of the created header file
  // @param sourcePath - URI of the created source file
  public async showSuccessAndOpenFile(headerPath: vscode.Uri,
    sourcePath: vscode.Uri): Promise<void> {
    await vscode.window.showTextDocument(
      await vscode.workspace.openTextDocument(headerPath));
    await vscode.window.showInformationMessage(
      `Successfully created ${path.basename(headerPath.fsPath)} and ${path.basename(sourcePath.fsPath)}.`);
  }
}

// Main Coordinator Class

// PairCreator coordinates the UI and Service layers to handle the complete file
// pair creation workflow. It serves as the main entry point and orchestrates
// the entire process.
class PairCreator implements vscode.Disposable {
  private command: vscode.Disposable;
  private service: PairCreatorService;
  private ui: PairCreatorUI;

  // Constructor registers the VS Code command for creating source/header pairs
  constructor() {
    this.service = new PairCreatorService();
    this.ui = new PairCreatorUI(this.service);
    this.command = vscode.commands.registerCommand(
      'clangd.createSourceHeaderPair', this.create, this);
  }

  // Dispose method for cleanup when extension is deactivated
  dispose() { this.command.dispose(); }

  // Main entry point for the file pair creation process.
  // Orchestrates the entire workflow using the service and UI layers.
  public async create(): Promise<void> {
    try {
      const targetDirectory = await this.service.getTargetDirectory();
      if (!targetDirectory) {
        vscode.window.showErrorMessage(
          'Cannot determine target directory. Please open a folder or a file first.');
        return;
      }

      const { language, uncertain } = await this.service.detectLanguage();
      const rule = await this.ui.promptForPairingRule(language, uncertain);
      if (!rule)
        return;

      const fileName = await this.ui.promptForFileName(rule);
      if (!fileName)
        return;

      const headerPath = vscode.Uri.file(
        path.join(targetDirectory.fsPath, `${fileName}${rule.headerExt}`));
      const sourcePath = vscode.Uri.file(
        path.join(targetDirectory.fsPath, `${fileName}${rule.sourceExt}`));

      const existingFilePath =
        await this.service.checkFileExistence(headerPath, sourcePath);
      if (existingFilePath) {
        vscode.window.showErrorMessage(
          `File already exists: ${existingFilePath}`);
        return;
      }

      const eol = this.service.getLineEnding();
      const { headerContent, sourceContent } =
        this.service.generateFileContent(fileName, eol, rule);

      await this.service.writeFiles(headerPath, sourcePath, headerContent,
        sourceContent);
      await this.ui.showSuccessAndOpenFile(headerPath, sourcePath);

    } catch (error: any) {
      vscode.window.showErrorMessage(error.message ||
        'An unexpected error occurred.');
    }
  }
}

// Registers the create source/header pair command with the VS Code extension
// context. This function should be called during extension activation to make
// the command available.
// @param context - The VS Code extension context for managing disposables
export function registerCreateSourceHeaderPairCommand(context: ClangdContext) {
  context.subscriptions.push(new PairCreator());
}
