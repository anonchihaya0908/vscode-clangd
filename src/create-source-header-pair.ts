import * as path from 'path';
import * as vscode from 'vscode';
import * as os from 'os';

import { ClangdContext } from './clangd-context';
import * as PairingRuleService from './pairing-rule-service';

// --- Constants and Types ---

// Regular expressions for validating user input
const VALIDATION_PATTERNS = {
  IDENTIFIER: /^[a-zA-Z_][a-zA-Z0-9_]*$/  // Valid C/C++ identifier pattern
} as const;

// Default placeholder names for different template types
const DEFAULT_PLACEHOLDERS = {
  C_EMPTY: 'my_c_functions',
  C_STRUCT: 'MyStruct',
  CPP_EMPTY: 'utils',
  CPP_CLASS: 'MyClass',
  CPP_STRUCT: 'MyStruct'
} as const;

// Defines the structure of a file pair template rule
interface PairingRule {
  key: string;           // Unique identifier for this rule
  label: string;         // Human-readable name shown in UI
  description: string;   // Detailed description of what this rule creates
  language: 'c' | 'cpp'; // Target programming language
  headerExt: string;     // File extension for header file (e.g., '.h')
  sourceExt: string;     // File extension for source file (e.g., '.cpp', '.c')
  isClass?: boolean;     // Whether this rule creates a class template
  isStruct?: boolean;    // Whether this rule creates a struct template
}

// Available template rules for creating different types of file pairs
const TEMPLATE_RULES: ReadonlyArray<PairingRule> = [
  {
    key: 'cpp_empty',
    label: '$(new-file) Empty C++ Pair',
    description: 'Creates a basic .h/.cpp file pair with header guards.',
    language: 'cpp', headerExt: '.h', sourceExt: '.cpp'
  },
  {
    key: 'cpp_class',
    label: '$(symbol-class) C++ Class',
    description: 'Creates a .h/.cpp pair with a boilerplate class definition.',
    language: 'cpp', headerExt: '.h', sourceExt: '.cpp', isClass: true
  },
  {
    key: 'cpp_struct',
    label: '$(symbol-struct) C++ Struct',
    description: 'Creates a .h/.cpp pair with a boilerplate struct definition.',
    language: 'cpp', headerExt: '.h', sourceExt: '.cpp', isStruct: true
  },
  {
    key: 'c_empty',
    label: '$(file-code) Empty C Pair',
    description: 'Creates a basic .h/.c file pair for function declarations.',
    language: 'c', headerExt: '.h', sourceExt: '.c'
  },
  {
    key: 'c_struct',
    label: '$(symbol-struct) C Struct',
    description: 'Creates a .h/.c pair with a boilerplate typedef struct.',
    language: 'c', headerExt: '.h', sourceExt: '.c', isStruct: true
  }
];

// --- Main Class ---

// Main class responsible for creating header/source file pairs
class PairCreator implements vscode.Disposable {
  private command: vscode.Disposable;

  constructor() {
    this.command = vscode.commands.registerCommand('clangd.createSourceHeaderPair', this.create, this);
  }

  dispose() { this.command.dispose(); }

  // Main entry point for creating a source/header file pair
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

      const eol = this.getLineEnding();
      const { headerContent, sourceContent } = this.generateFileContent(fileName, eol, rule);

      await this.writeFiles(headerPath, sourcePath, headerContent, sourceContent);
      await this.finalizeCreation(headerPath, sourcePath);

    } catch (error: any) {
      vscode.window.showErrorMessage(error.message || 'An unexpected error occurred.');
    }
  }

  // --- Helper Methods ---

  private getLineEnding(): string {
    const eolSetting = vscode.workspace.getConfiguration('files').get<string>('eol');
    return (eolSetting === '\n' || eolSetting === '\r\n') ? eolSetting : os.EOL;
  }

  // Detects the programming language context (C or C++) based on the current active file
  private async detectLanguage(): Promise<{ language: 'c' | 'cpp', uncertain: boolean }> {
    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor || activeEditor.document.isUntitled) {
      return { language: 'cpp', uncertain: true };
    }

    const document = activeEditor.document;
    const langId = document.languageId;
    const filePath = document.uri.fsPath;
    const ext = path.extname(filePath);

    // Strategy 1: Trust definitive source file extensions
    if (ext === '.c') return { language: 'c', uncertain: false };
    if (ext === '.cpp' || ext === '.cc' || ext === '.cxx') return { language: 'cpp', uncertain: false };

    // Strategy 1.5: Trust definitive C++ header file extensions
    if (ext === '.hh' || ext === '.hpp' || ext === '.hxx') return { language: 'cpp', uncertain: false };

    // Strategy 2: For generic header files (.h), infer language from companion source files
    if (ext === '.h') {
      const baseName = path.basename(filePath, '.h');
      const dirPath = path.dirname(filePath);

      const companionChecks = [
        path.join(dirPath, `${baseName}.c`),     // C source file
        path.join(dirPath, `${baseName}.cpp`),   // C++ source file
        path.join(dirPath, `${baseName}.cc`),    // Alternative C++ extension
        path.join(dirPath, `${baseName}.cxx`)    // Alternative C++ extension
      ];

      const results = await Promise.allSettled(
        companionChecks.map(file => vscode.workspace.fs.stat(vscode.Uri.file(file)))
      );

      if (results[0].status === 'fulfilled') return { language: 'c', uncertain: false };
      if (results.slice(1).some(r => r.status === 'fulfilled')) return { language: 'cpp', uncertain: false };

      return { language: 'cpp', uncertain: true };
    }

    // Strategy 3: Fallback to VS Code's language detection
    return { language: (langId === 'c' ? 'c' : 'cpp'), uncertain: true };
  }

  // Converts a string to PascalCase by splitting on hyphens and underscores
  private toPascalCase(input: string): string {
    return input.split(/[-_]/).map(word => word.charAt(0).toUpperCase() + word.slice(1)).join('');
  }

  // Generates an appropriate placeholder for the file name input
  private getPlaceholder(rule: PairingRule): string {
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor && !activeEditor.document.isUntitled) {
      const currentFileName = path.basename(activeEditor.document.fileName, path.extname(activeEditor.document.fileName));
      // C uses snake_case by convention, C++ typically uses PascalCase for classes
      if (rule.language === 'c') return currentFileName;
      return this.toPascalCase(currentFileName);
    }

    if (rule.isClass) return DEFAULT_PLACEHOLDERS.CPP_CLASS;
    if (rule.isStruct && rule.language === 'cpp') return DEFAULT_PLACEHOLDERS.CPP_STRUCT;
    if (rule.isStruct && rule.language === 'c') return DEFAULT_PLACEHOLDERS.C_STRUCT;
    if (rule.language === 'c') return DEFAULT_PLACEHOLDERS.C_EMPTY;
    return DEFAULT_PLACEHOLDERS.CPP_EMPTY;
  }

  // Checks for custom pairing rules and offers to create them if not found
  // Returns: PairingRule if user selected a rule, null if user cancelled, undefined if no custom rules exist, 'use_default' if user wants default templates
  private async checkAndOfferCustomRules(language: 'c' | 'cpp', uncertain: boolean): Promise<PairingRule | null | undefined | 'use_default'> {
    // First check workspace rules, then global rules
    const workspaceRules = PairingRuleService.getRules('workspace');
    const globalRules = PairingRuleService.getRules('user');

    // Combine available rules (workspace takes precedence)
    const availableRules = [...(workspaceRules || []), ...(globalRules || [])];

    // Check if we have any custom rules for the detected language
    const languageRules = availableRules.filter(rule => rule.language === language);

    if (languageRules.length > 0) {
      // We have custom rules for this language, let user choose
      const result = await this.selectFromCustomRules(languageRules, language);
      // If user cancelled (result is undefined), return null to indicate cancellation
      if (result === undefined) {
        return null;
      }
      return result; // This can be PairingRule or 'use_default'
    }

    // No custom rules found, check if user wants to create some
    if (!uncertain) {
      const shouldCreateRules = await this.offerToCreateCustomRules(language);
      if (shouldCreateRules === null) {
        // User cancelled the dialog
        return null;
      }
      if (shouldCreateRules) {
        const result = await this.createCustomRules(language);
        // If user cancelled during custom rule creation, return null
        return result === undefined ? null : result;
      }
    }

    return undefined; // Fall back to default behavior
  }

  // Let user select from available custom rules
  private async selectFromCustomRules(rules: PairingRule[], language: 'c' | 'cpp'): Promise<PairingRule | undefined | 'use_default'> {
    // Find the most common custom rule extensions for the detected language
    const languageRules = rules.filter(rule => rule.language === language);
    let customHeaderExt: string | undefined;
    let customSourceExt: string | undefined;

    if (languageRules.length > 0) {
      // Use the first custom rule's extensions as the standard
      customHeaderExt = languageRules[0].headerExt;
      customSourceExt = languageRules[0].sourceExt;
    }

    // Create adapted default templates that match the custom extensions
    let adaptedDefaultTemplates: PairingRule[] = [];

    if (customHeaderExt && customSourceExt && language === 'cpp') {
      // Only adapt C++ templates if we have custom C++ extensions
      adaptedDefaultTemplates = TEMPLATE_RULES
        .filter(template => template.language === 'cpp')
        .filter(template => {
          // Only include if no custom rule has exactly the same functionality
          return !languageRules.some(customRule =>
            customRule.isClass === template.isClass &&
            customRule.isStruct === template.isStruct &&
            (customRule.isClass || customRule.isStruct || (!customRule.isClass && !customRule.isStruct && !template.isClass && !template.isStruct))
          );
        })
        .map(template => ({
          ...template,
          key: `${template.key}_adapted`,
          headerExt: customHeaderExt!,
          sourceExt: customSourceExt!,
          label: template.label,
          description: template.description
            .replace(/\.h\/\.cpp/, `${customHeaderExt}/${customSourceExt}`)
            .replace(/basic \.h\/\.cpp/, `basic ${customHeaderExt}/${customSourceExt}`)
            .replace(/Creates a \.h\/\.cpp/, `Creates a ${customHeaderExt}/${customSourceExt}`)
        }));
    } else {
      // If no custom extensions or not C++, use default templates but filter out exact duplicates
      adaptedDefaultTemplates = TEMPLATE_RULES
        .filter(template => template.language === language)
        .filter(template => {
          return !languageRules.some(customRule =>
            customRule.headerExt === template.headerExt &&
            customRule.sourceExt === template.sourceExt &&
            customRule.isClass === template.isClass &&
            customRule.isStruct === template.isStruct
          );
        });
    }

    // Add all other language templates (C templates if we're in C++ context, etc.)
    const otherLanguageTemplates = TEMPLATE_RULES.filter(template => template.language !== language);

    // Clean up custom rules labels and ensure they have proper icons
    const cleanedCustomRules = rules.map(rule => ({
      ...rule,
      label: rule.label.includes('$(') ? rule.label : `$(new-file) ${rule.language === 'cpp' ? 'C++' : 'C'} Pair (${rule.headerExt}/${rule.sourceExt})`,
      description: rule.description.startsWith('Creates a') ? rule.description : `Creates a ${rule.headerExt}/${rule.sourceExt} file pair with header guards.`
    }));

    // Add option to use default rules
    const choices: (PairingRule | { key: string; label: string; description: string; isSpecial: boolean })[] = [
      ...cleanedCustomRules,
      ...adaptedDefaultTemplates,
      ...otherLanguageTemplates,
      {
        key: 'use_default',
        label: '$(list-unordered) Use Default Templates',
        description: 'Use the built-in default pairing rules instead of custom rules',
        isSpecial: true
      }
    ];

    const result = await vscode.window.showQuickPick(choices, {
      placeHolder: `Select a ${language.toUpperCase()} pairing rule`,
      title: 'Custom Pairing Rules Available'
    });

    if (!result) return undefined;

    // Check if this is a special action (not a rule)
    if ('isSpecial' in result && result.isSpecial) {
      if (result.key === 'use_default') {
        return 'use_default'; // Special return value to indicate use default templates
      }
    }

    // If it's not a special action, it's a rule (either custom or C template)
    return result as PairingRule;
  }

  // Offers to create custom rules for the detected language
  // Returns: true if user wants to create custom rules, false if user chooses defaults, null if user cancels
  private async offerToCreateCustomRules(language: 'c' | 'cpp'): Promise<boolean | null> {
    const languageName = language.toUpperCase();
    const message = `No custom pairing rules found for ${languageName}. Would you like to create custom rules to use different file extensions (e.g., .cc/.hh instead of .cpp/.h)?`;

    const result = await vscode.window.showInformationMessage(
      message,
      { modal: false },
      'Create Custom Rules',
      'Use Defaults'
    );

    if (result === 'Create Custom Rules') {
      return true;
    } else if (result === 'Use Defaults') {
      return false;
    } else {
      // User cancelled the dialog (pressed ESC or clicked outside)
      return null;
    }
  }

  // Creates custom rules with user input
  private async createCustomRules(language: 'c' | 'cpp'): Promise<PairingRule | undefined> {
    const languageName = language.toUpperCase();

    // Predefined common extension combinations
    const commonExtensions = language === 'cpp'
      ? [
        { label: '.h / .cpp (Default)', headerExt: '.h', sourceExt: '.cpp' },
        { label: '.hh / .cc (Alternative)', headerExt: '.hh', sourceExt: '.cc' },
        { label: '.hpp / .cpp (Header Plus Plus)', headerExt: '.hpp', sourceExt: '.cpp' },
        { label: '.hxx / .cxx (Extended)', headerExt: '.hxx', sourceExt: '.cxx' },
        { label: 'Custom Extensions', headerExt: '', sourceExt: '' }
      ]
      : [
        { label: '.h / .c (Default)', headerExt: '.h', sourceExt: '.c' },
        { label: 'Custom Extensions', headerExt: '', sourceExt: '' }
      ];

    const selectedExtension = await vscode.window.showQuickPick(commonExtensions, {
      placeHolder: `Select file extensions for ${languageName} files`,
      title: 'Choose File Extensions'
    });

    if (!selectedExtension) return undefined;

    let headerExt = selectedExtension.headerExt;
    let sourceExt = selectedExtension.sourceExt;

    // If custom extensions selected, prompt for input
    if (!headerExt || !sourceExt) {
      const inputHeaderExt = await vscode.window.showInputBox({
        prompt: 'Enter header file extension (e.g., .h, .hh, .hpp)',
        placeHolder: '.h',
        validateInput: (text) => {
          if (!text || !text.startsWith('.') || text.length < 2) {
            return 'Please enter a valid file extension starting with a dot (e.g., .h)';
          }
          return null;
        }
      });

      if (!inputHeaderExt) return undefined;
      headerExt = inputHeaderExt;

      const inputSourceExt = await vscode.window.showInputBox({
        prompt: `Enter source file extension for ${languageName} (e.g., .c, .cpp, .cc)`,
        placeHolder: language === 'cpp' ? '.cpp' : '.c',
        validateInput: (text) => {
          if (!text || !text.startsWith('.') || text.length < 2) {
            return 'Please enter a valid file extension starting with a dot (e.g., .cpp)';
          }
          return null;
        }
      });

      if (!inputSourceExt) return undefined;
      sourceExt = inputSourceExt;
    }

    // Create the custom rule
    const customRule: PairingRule = {
      key: `custom_${language}_${Date.now()}`,
      label: `$(new-file) ${language === 'cpp' ? 'C++' : 'C'} Pair (${headerExt}/${sourceExt})`,
      description: `Creates a ${headerExt}/${sourceExt} file pair with header guards.`,
      language: language,
      headerExt: headerExt,
      sourceExt: sourceExt
    };

    // Ask where to save the rule
    const saveLocation = await vscode.window.showQuickPick([
      { label: 'Workspace Settings', description: 'Save to current workspace only', value: 'workspace' },
      { label: 'Global Settings', description: 'Save to user settings (available in all workspaces)', value: 'user' }
    ], {
      placeHolder: 'Where would you like to save this custom rule?',
      title: 'Save Location'
    });

    if (!saveLocation) return undefined;

    try {
      // Get existing rules and add the new one
      const existingRules = PairingRuleService.getRules(saveLocation.value as 'workspace' | 'user') || [];
      const updatedRules = [...existingRules, customRule];

      await PairingRuleService.writeRules(updatedRules, saveLocation.value as 'workspace' | 'user');

      const locationText = saveLocation.value === 'workspace' ? 'workspace' : 'global';
      vscode.window.showInformationMessage(`Custom pairing rule saved to ${locationText} settings.`);

      return customRule;
    } catch (error: any) {
      vscode.window.showErrorMessage(`Failed to save custom rule: ${error.message}`);
      return undefined;
    }
  }

  // Prompts the user to select a file pair template type from available options
  private async promptForPairingRule(language: 'c' | 'cpp', uncertain: boolean): Promise<PairingRule | undefined> {
    // Check if we have custom pairing rules for the detected language
    const customRulesResult = await this.checkAndOfferCustomRules(language, uncertain);

    // If user cancelled at any point during custom rules flow, exit completely
    if (customRulesResult === null) {
      return undefined;
    }

    // If user chose to use default templates, fall through to default template selection
    if (customRulesResult === 'use_default') {
      // Continue to default template selection below
    } else if (customRulesResult) {
      // If checkAndOfferCustomRules returns a rule, use it
      return customRulesResult;
    }

    let desiredOrder: string[];

    if (uncertain) {
      desiredOrder = ['cpp_empty', 'c_empty', 'cpp_class', 'cpp_struct', 'c_struct'];
    } else if (language === 'c') {
      desiredOrder = ['c_empty', 'c_struct', 'cpp_empty', 'cpp_class', 'cpp_struct'];
    } else {
      desiredOrder = ['cpp_empty', 'cpp_class', 'cpp_struct', 'c_empty', 'c_struct'];
    }

    const choices = [...TEMPLATE_RULES]
      .sort((a, b) => desiredOrder.indexOf(a.key) - desiredOrder.indexOf(b.key));

    const result = await vscode.window.showQuickPick(choices, {
      placeHolder: 'Please select the type of file pair to create.',
      title: 'Create Pair - Step 1 of 2'
    });

    return result;
  }

  // Prompts the user to enter a name for the new file pair
  private async promptForFileName(rule: PairingRule): Promise<string | undefined> {
    let prompt = 'Please enter a name.';
    if (rule.isClass) prompt = 'Please enter the name for the new C++ class.';
    else if (rule.isStruct) prompt = `Please enter the name for the new ${rule.language.toUpperCase()} struct.`;
    else prompt = `Please enter the base name for the new ${rule.language.toUpperCase()} file pair.`;

    return vscode.window.showInputBox({
      prompt,
      placeHolder: this.getPlaceholder(rule),
      validateInput: (text) => VALIDATION_PATTERNS.IDENTIFIER.test(text?.trim() || '') ? null : 'Invalid C/C++ identifier.',
      title: 'Create Pair - Step 2 of 2'
    });
  }
  // Generates the content for both header and source files based on the selected template rule
  private generateFileContent(fileName: string, eol: string, rule: PairingRule): { headerContent: string, sourceContent: string } {
    const templates = this.getTemplatesByRule(rule);

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

  // Retrieves the appropriate file templates based on the selected pairing rule
  private getTemplatesByRule(rule: PairingRule): { header: string, source: string } {
    // C++ Class template with constructor/destructor
    if (rule.isClass) {
      return {
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
      };
    }

    // C++ Struct template
    if (rule.isStruct && rule.language === 'cpp') {
      return {
        header: `#ifndef {{headerGuard}}
#define {{headerGuard}}

struct {{fileName}} {
  // Struct members
};

#endif  // {{headerGuard}}
`,
        source: '{{includeLine}}'
      };
    }

    // C Struct template with typedef
    if (rule.isStruct && rule.language === 'c') {
      return {
        header: `#ifndef {{headerGuard}}
#define {{headerGuard}}

typedef struct {
  // Struct members
} {{fileName}};

#endif  // {{headerGuard}}
`,
        source: '{{includeLine}}'
      };
    }

    // C Empty file template
    if (rule.language === 'c') {
      return {
        header: `#ifndef {{headerGuard}}
#define {{headerGuard}}

// Declarations for {{fileName}}.c

#endif  // {{headerGuard}}
`,
        source: `{{includeLine}}

// Implementations for {{fileName}}.c
`
      };
    }

    // C++ Empty file template (default)
    return {
      header: `#ifndef {{headerGuard}}
#define {{headerGuard}}

// Declarations for {{fileName}}.cpp

#endif  // {{headerGuard}}
`,
      source: '{{includeLine}}'
    };
  }

  // Applies template variable substitution using {{variable}} placeholders
  private applyTemplate(template: string, context: Record<string, string>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
      return context[key] || match;
    });
  }

  private async checkFileExistence(headerPath: vscode.Uri, sourcePath: vscode.Uri): Promise<string | null> {
    const pathsToCheck = [headerPath, sourcePath];
    for (const filePath of pathsToCheck) {
      try {
        await vscode.workspace.fs.stat(filePath);
        return filePath.fsPath;
      } catch {
        // File doesn't exist, continue checking
      }
    }
    return null;
  }

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

  private async finalizeCreation(headerPath: vscode.Uri, sourcePath: vscode.Uri): Promise<void> {
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(headerPath));
    await vscode.window.showInformationMessage(
      `Successfully created ${path.basename(headerPath.fsPath)} and ${path.basename(sourcePath.fsPath)}.`
    );
  }

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

// Registers the create source/header pair command with the VS Code extension context
export function registerCreateSourceHeaderPairCommand(context: ClangdContext) {
  context.subscriptions.push(new PairCreator());
}