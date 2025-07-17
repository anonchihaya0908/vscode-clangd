import * as path from 'path';
import * as vscode from 'vscode';

import { ClangdContext } from './clangd-context';
import { PairingRuleService, PairingRule } from './pairing-rule-manager';

// Regular expression pattern to validate C/C++ identifiers (function names, class names, etc.)
const VALIDATION_PATTERNS = { IDENTIFIER: /^[a-zA-Z_][a-zA-Z0-9_]*$/ } as const;

// Default placeholder names shown to users when creating different types of files
const DEFAULT_PLACEHOLDERS = { C_EMPTY: 'my_c_functions', C_STRUCT: 'MyStruct', CPP_EMPTY: 'utils', CPP_CLASS: 'MyClass', CPP_STRUCT: 'MyStruct' } as const;

// Template rules define the available file pair types that users can choose from
// Each rule specifies the language, file extensions, and optional flags for classes/structs
const TEMPLATE_RULES: ReadonlyArray<PairingRule> = [
  { key: 'cpp_empty', label: '$(new-file) C++ Pair', description: 'Creates a basic Header/Source file pair with header guards.', language: 'cpp', headerExt: '.h', sourceExt: '.cpp' },
  { key: 'cpp_class', label: '$(symbol-class) C++ Class', description: 'Creates a Header/Source file pair with a boilerplate class definition.', language: 'cpp', headerExt: '.h', sourceExt: '.cpp', isClass: true },
  { key: 'cpp_struct', label: '$(symbol-struct) C++ Struct', description: 'Creates a Header/Source file pair with a boilerplate struct definition.', language: 'cpp', headerExt: '.h', sourceExt: '.cpp', isStruct: true },
  { key: 'c_empty', label: '$(file-code) C Pair', description: 'Creates a basic .h/.c file pair for function declarations.', language: 'c', headerExt: '.h', sourceExt: '.c' },
  { key: 'c_struct', label: '$(symbol-struct) C Struct', description: 'Creates a .h/.c file pair with a boilerplate typedef struct.', language: 'c', headerExt: '.h', sourceExt: '.c', isStruct: true }
];

// File templates contain the actual code structure for different types of C/C++ files
// Templates use {{placeholder}} syntax for variable substitution (fileName, headerGuard, includeLine)
const FILE_TEMPLATES = {
  // C++ class template with constructor/destructor and private members section
  CPP_CLASS: {
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
  },
  // C++ struct template with basic member declaration area
  CPP_STRUCT: {
    header: `#ifndef {{headerGuard}}
#define {{headerGuard}}

struct {{fileName}} {
  // Struct members
};

#endif  // {{headerGuard}}
`,
    source: '{{includeLine}}'
  },
  // C struct template using typedef for traditional C-style struct definition
  C_STRUCT: {
    header: `#ifndef {{headerGuard}}
#define {{headerGuard}}

typedef struct {
  // Struct members
} {{fileName}};

#endif  // {{headerGuard}}
`,
    source: '{{includeLine}}'
  },
  // Empty C file template with basic header/source structure for function declarations
  C_EMPTY: {
    header: `#ifndef {{headerGuard}}
#define {{headerGuard}}

// Declarations for {{fileName}}.c

#endif  // {{headerGuard}}
`,
    source: `{{includeLine}}

// Implementations for {{fileName}}.c
`
  },
  // Empty C++ file template with basic header/source structure for general declarations
  CPP_EMPTY: {
    header: `#ifndef {{headerGuard}}
#define {{headerGuard}}

// Declarations for {{fileName}}.cpp

#endif  // {{headerGuard}}
`,
    source: '{{includeLine}}'
  }
} as const;

// Main Class

// PairCreator is the main class responsible for creating header/source file pairs.
// It handles the entire workflow: language detection, rule selection, file generation, and writing.
class PairCreator implements vscode.Disposable {
  private command: vscode.Disposable;

  // Constructor registers the VS Code command for creating source/header pairs
  constructor() {
    this.command = vscode.commands.registerCommand('clangd.createSourceHeaderPair', this.create, this);
  }

  // Dispose method for cleanup when extension is deactivated
  dispose() { this.command.dispose(); }

  // Main entry point for the file pair creation process.
  // Orchestrates the entire workflow from directory selection to file writing.
  public async create(): Promise<void> {
    try {
      const targetDirectory = await this.getTargetDirectory();
      if (!targetDirectory) {
        vscode.window.showErrorMessage('Cannot determine target directory. Please open a folder or a file first.');
        return;
      }

      const { language, uncertain } = await this.detectLanguage();
      const rule = await this.promptForPairingRule(language, uncertain);
      if (!rule) return;

      const fileName = await this.promptForFileName(rule);
      if (!fileName) return;

      const headerPath = vscode.Uri.file(path.join(targetDirectory.fsPath, `${fileName}${rule.headerExt}`));
      const sourcePath = vscode.Uri.file(path.join(targetDirectory.fsPath, `${fileName}${rule.sourceExt}`));

      const existingFilePath = await this.checkFileExistence(headerPath, sourcePath);
      if (existingFilePath) {
        vscode.window.showErrorMessage(`File already exists: ${existingFilePath}`);
        return;
      }

      const eolSetting = vscode.workspace.getConfiguration('files').get<string>('eol');
      const eol = (eolSetting === '\n' || eolSetting === '\r\n') ? eolSetting : '\n';
      const { headerContent, sourceContent } = this.generateFileContent(fileName, eol, rule);

      await this.writeFiles(headerPath, sourcePath, headerContent, sourceContent);
      await this.finalizeCreation(headerPath, sourcePath);

    } catch (error: any) {
      vscode.window.showErrorMessage(error.message || 'An unexpected error occurred.');
    }
  }

  // Adapts template rules to use custom file extensions when available.
  // This method updates rule descriptions and extensions based on user's custom configuration.
  // @param rule - The template rule to adapt
  // @param detectedLanguage - The detected programming language (c or cpp)
  // @returns Adapted rule with updated extensions and descriptions
  private adaptRuleForCurrentExtensions(rule: PairingRule, detectedLanguage: 'c' | 'cpp'): PairingRule {
    if (rule.language !== 'cpp') return rule;

    const allRules = [...(PairingRuleService.getRules('workspace') || []), ...(PairingRuleService.getRules('user') || [])];
    const cppCustomRules = allRules.filter(r => r.language === 'cpp');

    if (cppCustomRules.length > 0) {
      const { headerExt: targetHeaderExt, sourceExt: targetSourceExt } = cppCustomRules[0];
      const newDescription = rule.description
        .replace(/Header\/Source/g, `${targetHeaderExt}/${targetSourceExt}`)
        .replace(/\.h\/\.cpp/g, `${targetHeaderExt}/${targetSourceExt}`)
        .replace(/\.hh\/\.cc/g, `${targetHeaderExt}/${targetSourceExt}`)
        .replace(/\.hpp\/\.cpp/g, `${targetHeaderExt}/${targetSourceExt}`)
        .replace(/\.hxx\/\.cxx/g, `${targetHeaderExt}/${targetSourceExt}`);

      return { ...rule, description: newDescription, headerExt: targetHeaderExt, sourceExt: targetSourceExt };
    }

    return rule;
  }

  // Detects the programming language (C or C++) based on the currently active file.
  // Uses file extensions and companion file analysis for accurate detection.
  // @returns Object containing the detected language and uncertainty flag
  private async detectLanguage(): Promise<{ language: 'c' | 'cpp', uncertain: boolean }> {
    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor || activeEditor.document.isUntitled) {
      return { language: 'cpp', uncertain: true };
    }

    const { languageId: langId, uri: { fsPath: filePath } } = activeEditor.document;
    const ext = path.extname(filePath);

    // Definitive extensions
    if (ext === '.c') return { language: 'c', uncertain: false };
    if (['.cpp', '.cc', '.cxx'].includes(ext)) return { language: 'cpp', uncertain: false };
    if (['.hh', '.hpp', '.hxx'].includes(ext)) return { language: 'cpp', uncertain: false };

    // For .h files, check for companion source files
    if (ext === '.h') {
      const baseName = path.basename(filePath, '.h');
      const dirPath = path.dirname(filePath);
      const companions = ['.c', '.cpp', '.cc', '.cxx'].map(e => path.join(dirPath, `${baseName}${e}`));

      const results = await Promise.allSettled(companions.map(f => vscode.workspace.fs.stat(vscode.Uri.file(f))));
      if (results[0].status === 'fulfilled') return { language: 'c', uncertain: false };
      if (results.slice(1).some(r => r.status === 'fulfilled')) return { language: 'cpp', uncertain: false };

      return { language: 'cpp', uncertain: true };
    }

    return { language: (langId === 'c' ? 'c' : 'cpp'), uncertain: true };
  }

  // Converts a string to PascalCase by capitalizing first letter of each word.
  // Used for generating C++ class/struct names from file names.
  // @param input - String to convert (e.g., "my_class_name")
  // @returns PascalCase string (e.g., "MyClassName")
  private toPascalCase(input: string): string {
    return input.split(/[-_]/).map(word => word.charAt(0).toUpperCase() + word.slice(1)).join('');
  }

  // Generates an appropriate placeholder name for the file name input field.
  // Uses current file name or defaults based on the selected template type.
  // @param rule - The pairing rule that determines the placeholder type
  // @returns Placeholder string to show in the input field
  private getPlaceholder(rule: PairingRule): string {
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor && !activeEditor.document.isUntitled) {
      const currentFileName = path.basename(activeEditor.document.fileName, path.extname(activeEditor.document.fileName));
      return rule.language === 'c' ? currentFileName : this.toPascalCase(currentFileName);
    }

    if (rule.isClass) return DEFAULT_PLACEHOLDERS.CPP_CLASS;
    if (rule.isStruct) return rule.language === 'cpp' ? DEFAULT_PLACEHOLDERS.CPP_STRUCT : DEFAULT_PLACEHOLDERS.C_STRUCT;
    return rule.language === 'c' ? DEFAULT_PLACEHOLDERS.C_EMPTY : DEFAULT_PLACEHOLDERS.CPP_EMPTY;
  }

  // Checks for existing custom pairing rules and offers to create them if not found.
  // For C++, presents options to use custom rules or create new ones.
  // For C, always uses default templates.
  // @param language - The detected programming language
  // @param uncertain - Whether language detection was uncertain
  // @returns Selected rule, null if cancelled, undefined for defaults, or 'use_default' flag
  private async checkAndOfferCustomRules(language: 'c' | 'cpp', uncertain: boolean): Promise<PairingRule | null | undefined | 'use_default'> {
    if (language === 'c') return undefined; // Always use default C templates

    const allRules = [...(PairingRuleService.getRules('workspace') || []), ...(PairingRuleService.getRules('user') || [])];
    const languageRules = allRules.filter(rule => rule.language === language);

    if (languageRules.length > 0) {
      const result = await this.selectFromCustomRules(languageRules, language);
      return result === undefined ? null : result;
    }

    if (!uncertain) {
      const shouldCreateRules = await this.offerToCreateCustomRules(language);
      if (shouldCreateRules === null) return null;
      if (shouldCreateRules) {
        const result = await this.createCustomRules(language);
        return result === undefined ? null : result;
      }
    }

    return undefined;
  }

  // Presents a selection dialog for custom pairing rules.
  // Combines custom rules with adapted default templates and cross-language options.
  // @param rules - Available custom pairing rules
  // @param language - The current programming language context
  // @returns Selected rule, undefined if cancelled, or 'use_default' flag
  private async selectFromCustomRules(rules: PairingRule[], language: 'c' | 'cpp'): Promise<PairingRule | undefined | 'use_default'> {
    const languageRules = rules.filter(rule => rule.language === language);
    const customExt = languageRules.length > 0 ? languageRules[0] : null;

    let adaptedDefaultTemplates: PairingRule[] = [];

    if (customExt && language === 'cpp') {
      adaptedDefaultTemplates = TEMPLATE_RULES
        .filter(template => template.language === 'cpp' && !languageRules.some(customRule =>
          customRule.isClass === template.isClass && customRule.isStruct === template.isStruct &&
          (customRule.isClass || customRule.isStruct || (!customRule.isClass && !customRule.isStruct && !template.isClass && !template.isStruct))
        ))
        .map(template => ({
          ...template, key: `${template.key}_adapted`, headerExt: customExt.headerExt, sourceExt: customExt.sourceExt,
          description: template.description.replace(/Header\/Source/g, `${customExt.headerExt}/${customExt.sourceExt}`)
            .replace(/\.h\/\.cpp/g, `${customExt.headerExt}/${customExt.sourceExt}`)
            .replace(/basic \.h\/\.cpp/g, `basic ${customExt.headerExt}/${customExt.sourceExt}`)
            .replace(/Creates a \.h\/\.cpp/g, `Creates a ${customExt.headerExt}/${customExt.sourceExt}`)
        }));
    } else {
      adaptedDefaultTemplates = TEMPLATE_RULES
        .filter(template => template.language === language && !languageRules.some(customRule =>
          customRule.headerExt === template.headerExt && customRule.sourceExt === template.sourceExt &&
          customRule.isClass === template.isClass && customRule.isStruct === template.isStruct
        ))
        .map(template => this.adaptRuleForCurrentExtensions(template, language));
    }

    const otherLanguageTemplates = TEMPLATE_RULES
      .filter(template => template.language !== language)
      .map(template => this.adaptRuleForCurrentExtensions(template, language));

    const cleanedCustomRules = rules.map(rule => ({
      ...rule,
      label: rule.label.includes('$(') ? rule.label : `$(new-file) ${rule.language === 'cpp' ? 'C++' : 'C'} Pair (${rule.headerExt}/${rule.sourceExt})`,
      description: rule.description.startsWith('Creates a') ? rule.description : `Creates a ${rule.headerExt}/${rule.sourceExt} file pair with header guards.`
    }));

    const choices = [
      ...cleanedCustomRules,
      ...adaptedDefaultTemplates,
      ...otherLanguageTemplates,
      { key: 'use_default', label: '$(list-unordered) Use Default Templates', description: 'Use the built-in default pairing rules instead of custom rules', isSpecial: true }
    ];

    const result = await vscode.window.showQuickPick(choices, {
      placeHolder: `Select a ${language.toUpperCase()} pairing rule`,
      title: 'Custom Pairing Rules Available',
    });

    if (!result) return undefined;
    if ('isSpecial' in result && result.isSpecial && result.key === 'use_default') return 'use_default';
    return result as PairingRule;
  }

  // Shows a dialog offering to create custom pairing rules for C++.
  // Only applicable for C++ since C uses standard .c/.h extensions.
  // @param language - The programming language (should be 'cpp')
  // @returns true to create rules, false to dismiss, null if cancelled
  private async offerToCreateCustomRules(language: 'c' | 'cpp'): Promise<boolean | null> {
    if (language === 'c') return false;

    const result = await vscode.window.showInformationMessage(
      `No custom pairing rules found for C++. Would you like to create custom rules to use different file extensions (e.g., .cc/.hh instead of .cpp/.h)?`,
      { modal: false }, 'Create Custom Rules', 'Dismiss'
    );

    return result === 'Create Custom Rules' ? true : result === 'Dismiss' ? false : null;
  }

  // Guides the user through creating custom pairing rules for C++.
  // Offers common extension combinations or allows custom input.
  // Saves the rule to workspace or global settings.
  // @param language - The programming language (should be 'cpp')
  // @returns The created custom rule or undefined if cancelled
  private async createCustomRules(language: 'c' | 'cpp'): Promise<PairingRule | undefined> {
    if (language === 'c') return undefined;

    const commonExtensions = [
      { label: '.h / .cpp (Default)', headerExt: '.h', sourceExt: '.cpp' },
      { label: '.hh / .cc (Alternative)', headerExt: '.hh', sourceExt: '.cc' },
      { label: '.hpp / .cpp (Header Plus Plus)', headerExt: '.hpp', sourceExt: '.cpp' },
      { label: '.hxx / .cxx (Extended)', headerExt: '.hxx', sourceExt: '.cxx' },
      { label: 'Custom Extensions', headerExt: '', sourceExt: '' }
    ];

    const selectedExtension = await vscode.window.showQuickPick(commonExtensions, {
      placeHolder: `Select file extensions for C++ files`, title: 'Choose File Extensions'
    });

    if (!selectedExtension) return undefined;

    let { headerExt, sourceExt } = selectedExtension;

    if (!headerExt || !sourceExt) {
      const validateExt = (text: string) => (!text || !text.startsWith('.') || text.length < 2) ? 'Please enter a valid file extension starting with a dot (e.g., .h)' : null;

      headerExt = await vscode.window.showInputBox({
        prompt: 'Enter header file extension (e.g., .h, .hh, .hpp)', placeHolder: '.h', validateInput: validateExt
      }) || '';

      if (!headerExt) return undefined;

      sourceExt = await vscode.window.showInputBox({
        prompt: `Enter source file extension for C++ (e.g., .cpp, .cc, .cxx)`, placeHolder: '.cpp', validateInput: validateExt
      }) || '';

      if (!sourceExt) return undefined;
    }

    const customRule: PairingRule = {
      key: `custom_cpp_${Date.now()}`,
      label: `$(new-file) C++ Pair (${headerExt}/${sourceExt})`,
      description: `Creates a ${headerExt}/${sourceExt} file pair with header guards.`,
      language: 'cpp', headerExt, sourceExt
    };

    const saveLocation = await vscode.window.showQuickPick([
      { label: 'Workspace Settings', description: 'Save to current workspace only', value: 'workspace' },
      { label: 'Global Settings', description: 'Save to user settings (available in all workspaces)', value: 'user' }
    ], { placeHolder: 'Where would you like to save this custom rule?', title: 'Save Location' });

    if (!saveLocation) return undefined;

    try {
      const existingRules = PairingRuleService.getRules(saveLocation.value as 'workspace' | 'user') || [];
      await PairingRuleService.writeRules([...existingRules, customRule], saveLocation.value as 'workspace' | 'user');

      const locationText = saveLocation.value === 'workspace' ? 'workspace' : 'global';
      vscode.window.showInformationMessage(`Custom pairing rule saved to ${locationText} settings.`);

      return customRule;
    } catch (error: any) {
      vscode.window.showErrorMessage(`Failed to save custom rule: ${error.message}`);
      return undefined;
    }
  }

  // Prompts the user to select a pairing rule from available options.
  // First checks for custom rules, then falls back to default templates.
  // @param language - The detected programming language
  // @param uncertain - Whether language detection was uncertain
  // @returns Selected pairing rule or undefined if cancelled
  private async promptForPairingRule(language: 'c' | 'cpp', uncertain: boolean): Promise<PairingRule | undefined> {
    const customRulesResult = await this.checkAndOfferCustomRules(language, uncertain);

    if (customRulesResult === null) return undefined;
    if (customRulesResult === 'use_default') {
      // Continue to default template selection
    } else if (customRulesResult) {
      return customRulesResult;
    }

    const desiredOrder = uncertain ? ['cpp_empty', 'c_empty', 'cpp_class', 'cpp_struct', 'c_struct'] :
      language === 'c' ? ['c_empty', 'c_struct', 'cpp_empty', 'cpp_class', 'cpp_struct'] :
        ['cpp_empty', 'cpp_class', 'cpp_struct', 'c_empty', 'c_struct'];

    const choices = [...TEMPLATE_RULES]
      .sort((a, b) => desiredOrder.indexOf(a.key) - desiredOrder.indexOf(b.key))
      .map(rule => this.adaptRuleForCurrentExtensions(rule, language));

    const result = await vscode.window.showQuickPick(choices, {
      placeHolder: 'Please select the type of file pair to create.',
      title: 'Create Source/Header Pair'
    });

    if (result && !uncertain && language !== result.language) {
      const detectedLangName = language === 'c' ? 'C' : 'C++';
      const selectedLangName = result.language === 'c' ? 'C' : 'C++';

      const shouldContinue = await vscode.window.showWarningMessage(
        `You're working in a ${detectedLangName} file but selected a ${selectedLangName} template. This may create files with incompatible extensions or content.`,
        'Continue Anyway', 'Cancel'
      );

      if (shouldContinue !== 'Continue Anyway') return undefined;
    }

    return result;
  }

  // Prompts the user to enter a name for the new file pair.
  // Validates input as a valid C/C++ identifier and provides context-appropriate prompts.
  // @param rule - The selected pairing rule that determines the prompt message
  // @returns The entered file name or undefined if cancelled
  private async promptForFileName(rule: PairingRule): Promise<string | undefined> {
    const prompt = rule.isClass ? 'Please enter the name for the new C++ class.' :
      rule.isStruct ? `Please enter the name for the new ${rule.language.toUpperCase()} struct.` :
        `Please enter the base name for the new ${rule.language.toUpperCase()} file pair.`;

    return vscode.window.showInputBox({
      prompt, placeHolder: this.getPlaceholder(rule),
      validateInput: (text) => VALIDATION_PATTERNS.IDENTIFIER.test(text?.trim() || '') ? null : 'Invalid C/C++ identifier.',
      title: 'Create Source/Header Pair'
    });
  }

  // Generates the actual file content for both header and source files.
  // Selects appropriate templates and applies variable substitution.
  // @param fileName - The base name for the files
  // @param eol - The line ending style to use
  // @param rule - The pairing rule that determines the template type
  // @returns Object containing generated header and source content
  private generateFileContent(fileName: string, eol: string, rule: PairingRule): { headerContent: string, sourceContent: string } {
    const templateKey = rule.isClass ? 'CPP_CLASS' :
      rule.isStruct ? (rule.language === 'cpp' ? 'CPP_STRUCT' : 'C_STRUCT') :
        rule.language === 'c' ? 'C_EMPTY' : 'CPP_EMPTY';

    const templates = FILE_TEMPLATES[templateKey];
    const context = {
      fileName,
      headerGuard: `${fileName.toUpperCase()}_H_`,
      includeLine: `#include "${fileName}${rule.headerExt}"`
    };

    const headerContent = this.applyTemplate(templates.header, context);
    const sourceContent = this.applyTemplate(templates.source, context);

    return {
      headerContent: headerContent.replace(/\n/g, eol),
      sourceContent: sourceContent.replace(/\n/g, eol)
    };
  }

  // Applies template variable substitution using {{placeholder}} syntax.
  // Replaces template variables with actual values from the context.
  // @param template - The template string containing {{variable}} placeholders
  // @param context - Object mapping variable names to their values
  // @returns Template string with variables replaced by actual values
  private applyTemplate(template: string, context: Record<string, string>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (match, key) => context[key] || match);
  }

  // Checks if header or source files already exist at the target location.
  // Prevents accidental overwriting of existing files.
  // @param headerPath - URI of the header file to check
  // @param sourcePath - URI of the source file to check
  // @returns Path of existing file if found, null if both files are available
  private async checkFileExistence(headerPath: vscode.Uri, sourcePath: vscode.Uri): Promise<string | null> {
    for (const filePath of [headerPath, sourcePath]) {
      try {
        await vscode.workspace.fs.stat(filePath);
        return filePath.fsPath;
      }
      // File doesn't exist, continue
      catch { }
    }
    return null;
  }

  // Writes the generated content to header and source files simultaneously.
  // Uses VS Code's file system API for reliable file creation.
  // @param headerPath - URI where the header file should be created
  // @param sourcePath - URI where the source file should be created
  // @param headerContent - Generated content for the header file
  // @param sourceContent - Generated content for the source file
  private async writeFiles(headerPath: vscode.Uri, sourcePath: vscode.Uri, headerContent: string, sourceContent: string): Promise<void> {
    try {
      await Promise.all([
        vscode.workspace.fs.writeFile(headerPath, Buffer.from(headerContent, 'utf8')),
        vscode.workspace.fs.writeFile(sourcePath, Buffer.from(sourceContent, 'utf8'))
      ]);
    } catch (error: any) {
      throw new Error(`Failed to create files: ${error.message}.`);
    }
  }

  // Completes the file creation process by opening the header file and showing success message.
  // Opens the newly created header file in the editor for immediate use.
  // @param headerPath - URI of the created header file
  // @param sourcePath - URI of the created source file
  private async finalizeCreation(headerPath: vscode.Uri, sourcePath: vscode.Uri): Promise<void> {
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(headerPath));
    await vscode.window.showInformationMessage(
      `Successfully created ${path.basename(headerPath.fsPath)} and ${path.basename(sourcePath.fsPath)}.`
    );
  }

  // Determines the target directory where new files should be created.
  // Prioritizes: current file's directory > single workspace folder > user selection from multiple workspaces.
  // @returns URI of the target directory or undefined if no suitable location found
  private async getTargetDirectory(): Promise<vscode.Uri | undefined> {
    const activeEditor = vscode.window.activeTextEditor;

    if (activeEditor && !activeEditor.document.isUntitled) {
      return vscode.Uri.file(path.dirname(activeEditor.document.uri.fsPath));
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders?.length === 1) return workspaceFolders[0].uri;

    if (workspaceFolders && workspaceFolders.length > 1) {
      const selectedFolder = await vscode.window.showWorkspaceFolderPick({
        placeHolder: 'Please select a workspace folder for the new files.'
      });
      return selectedFolder?.uri;
    }

    return undefined;
  }
}

// Registers the create source/header pair command with the VS Code extension context.
// This function should be called during extension activation to make the command available.
// @param context - The VS Code extension context for managing disposables
export function registerCreateSourceHeaderPairCommand(context: ClangdContext) {
  context.subscriptions.push(new PairCreator());
}
