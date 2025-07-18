//
// File Pair Creation Module for VS Code clangd Extension
// 
// OVERVIEW:
// This module implements a sophisticated file pair creation system for C/C++ projects.
// It allows users to quickly generate matched header (.h) and source (.c/.cpp) files
// with proper boilerplate code, header guards, and language-specific templates.
// 
// ARCHITECTURE:
// The module follows a clean three-layer architecture pattern:
// 
// 1. SERVICE LAYER (PairCreatorService):
//    - Pure business logic and data processing
//    - Language detection algorithms
//    - Template generation and file content creation
//    - File system utilities with caching
//    - No VS Code API dependencies (pure functions with dependency injection)
// 
// 2. UI LAYER (PairCreatorUI):
//    - User interface interactions and dialogs
//    - Input validation and user feedback
//    - VS Code API integrations (showQuickPick, showInputBox, etc.)
//    - Context gathering from active editor
// 
// 3. COORDINATOR LAYER (CreatePairCoordinator):
//    - Orchestrates the complete workflow
//    - Error handling and command registration
//    - Coordinates between Service and UI layers
// 
// KEY FEATURES:
// - Multi-strategy language detection (file extension, VS Code language ID, companion files)
// - Support for custom file extensions via workspace/user settings
// - Template system with C/C++ class, struct, and empty file templates
// - Smart directory detection and workspace folder handling
// - Language mismatch warnings for better user experience
// - Caching mechanisms for improved performance
// 
// WORKFLOW:
// 1. Detect target directory (current file's directory or workspace folder)
// 2. Analyze current context to determine programming language (C vs C++)
// 3. Present template options (custom rules or default templates)
// 4. Collect file name with validation
// 5. Check for existing files to prevent overwrites
// 6. Generate file content from templates
// 7. Write files and open header file for editing
// 
// EXTENSIBILITY:
// The architecture supports easy extension through:
// - New template types via TEMPLATE_RULES and FILE_TEMPLATES
// - Custom file extensions via PairingRuleService integration
// - Additional language detection strategies
// - Enhanced UI workflows without affecting business logic
//

import * as path from 'path';
import * as vscode from 'vscode';

import { ClangdContext } from './clangd-context';
import { PairingRule, PairingRuleService } from './pairing-rule-manager';

// Core type definitions for language and template identification
type Language = 'c' | 'cpp';
type TemplateKey = 'CPP_CLASS' | 'CPP_STRUCT' | 'C_STRUCT' | 'C_EMPTY' | 'CPP_EMPTY';

// Validation patterns for C/C++ identifier compliance
const VALIDATION_PATTERNS = {
  IDENTIFIER: /^[a-zA-Z_][a-zA-Z0-9_]*$/
};

// Default placeholder names used in input dialogs for different template types
const DEFAULT_PLACEHOLDERS = {
  C_EMPTY: 'my_c_functions',
  C_STRUCT: 'MyStruct',
  CPP_EMPTY: 'utils',
  CPP_CLASS: 'MyClass',
  CPP_STRUCT: 'MyStruct'
};

// Available template configurations for file pair creation
// Each rule defines the language, file extensions, and template characteristics
const TEMPLATE_RULES: PairingRule[] = [
  {
    key: 'cpp_empty',
    label: '$(new-file) C++ Pair',
    description: 'Creates a basic Header/Source file pair with header guards.',
    language: 'cpp',
    headerExt: '.h',
    sourceExt: '.cpp'
  },
  {
    key: 'cpp_class',
    label: '$(symbol-class) C++ Class',
    description:
      'Creates a Header/Source file pair with a boilerplate class definition.',
    language: 'cpp',
    headerExt: '.h',
    sourceExt: '.cpp',
    isClass: true
  },
  {
    key: 'cpp_struct',
    label: '$(symbol-struct) C++ Struct',
    description:
      'Creates a Header/Source file pair with a boilerplate struct definition.',
    language: 'cpp',
    headerExt: '.h',
    sourceExt: '.cpp',
    isStruct: true
  },
  {
    key: 'c_empty',
    label: '$(file-code) C Pair',
    description: 'Creates a basic .h/.c file pair for function declarations.',
    language: 'c',
    headerExt: '.h',
    sourceExt: '.c'
  },
  {
    key: 'c_struct',
    label: '$(symbol-struct) C Struct',
    description: 'Creates a .h/.c file pair with a boilerplate typedef struct.',
    language: 'c',
    headerExt: '.h',
    sourceExt: '.c',
    isStruct: true
  }
];

// Immutable template definitions for generating file content
// Templates use {{variableName}} syntax for placeholder substitution
// Each template type (class, struct, empty) has both header and source variants
const FILE_TEMPLATES = {
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
  CPP_EMPTY: {
    header: `#ifndef {{headerGuard}}
#define {{headerGuard}}

// Declarations for {{fileName}}.cpp

#endif  // {{headerGuard}}
`,
    source: '{{includeLine}}'
  }
};

//
// SERVICE LAYER - Core Business Logic
// 
// PairCreatorService contains all the pure business logic for file pair creation.
// It operates without any VS Code API dependencies, making it highly testable
// and reusable. All external dependencies are injected through method parameters.
// 
// Key Responsibilities:
// - Language detection using multiple strategies
// - Template content generation and variable substitution
// - File system operations with caching
// - Business rule validation and logic
// - Pure function computations
//
class PairCreatorService {
  // Pre-compiled file extension sets for fast language detection lookup
  // Used in the fast-path of language detection algorithm
  public static readonly DEFINITIVE_EXTENSIONS = {
    c: new Set(['.c']),
    cpp: new Set(['.cpp', '.cc', '.cxx', '.hh', '.hpp', '.hxx'])
  };


  // Detects programming language from file information using multiple detection strategies.
  // Implementation approach:
  // 1. Fast path: Use file extension lookup for definitive extensions (.c, .cpp, .cc, etc.)
  // 2. VS Code integration: Leverage VS Code's language detection for accuracy
  // 3. Header file analysis: For .h files, examine companion files to determine C vs C++
  // 4. Fallback strategy: Return best guess with uncertainty flag
  // This multi-layered approach ensures high accuracy while maintaining performance.
  public async detectLanguage(languageId?: string, filePath?: string,
    fileExistsCheck?: (path: string) => Promise<boolean>):
    Promise<{ language: Language, uncertain: boolean }> {
    if (!languageId || !filePath) {
      return { language: 'cpp', uncertain: true };
    }

    const ext = path.extname(filePath);

    // Fast path for definitive extensions
    if (PairCreatorService.DEFINITIVE_EXTENSIONS.c.has(ext)) {
      return { language: 'c', uncertain: false };
    }
    if (PairCreatorService.DEFINITIVE_EXTENSIONS.cpp.has(ext)) {
      return { language: 'cpp', uncertain: false };
    }

    // Use VS Code's language detection for better accuracy
    if (languageId === 'c') {
      return { language: 'c', uncertain: false };
    }
    if (languageId === 'cpp' || languageId === 'cxx') {
      return { language: 'cpp', uncertain: false };
    }

    // Special handling for .h files with companion file detection
    if (ext === '.h') {
      const result = await this.detectLanguageForHeaderFile(filePath, fileExistsCheck);
      if (result)
        return result;
    }

    // Fallback with uncertainty
    return { language: languageId === 'c' ? 'c' : 'cpp', uncertain: true };
  }

  // Specialized language detection for header files (.h) using companion file analysis.
  // Implementation approach:
  // 1. Check for C companion files first (.c extension) - less common, early exit optimization
  // 2. Parallel check for C++ companion files (.cpp, .cc, .cxx) - common extensions
  // 3. Return confident result if companion found, uncertain C++ default otherwise
  // This targeted approach resolves the C vs C++ ambiguity for .h files by examining
  // the project context rather than relying on heuristics or content analysis.
  private async detectLanguageForHeaderFile(filePath: string,
    fileExistsCheck?: (path: string) => Promise<boolean>):
    Promise<{ language: Language, uncertain: boolean } | null> {
    if (!fileExistsCheck) {
      return { language: 'cpp', uncertain: true };
    }

    const baseName = path.basename(filePath, '.h');
    const dirPath = path.dirname(filePath);

    // Check for C companion file first (less common, check first for early
    // exit)
    const cFile = path.join(dirPath, `${baseName}.c`);
    if (await fileExistsCheck(cFile)) {
      return { language: 'c', uncertain: false };
    }

    // Check for C++ companion files in parallel
    const cppExtensions = ['.cpp', '.cc', '.cxx'];
    const cppChecks =
      cppExtensions.map(ext => fileExistsCheck(
        path.join(dirPath, `${baseName}${ext}`)));

    const results = await Promise.all(cppChecks);
    if (results.some((exists: boolean) => exists)) {
      return { language: 'cpp', uncertain: false };
    }

    return { language: 'cpp', uncertain: true };
  }

  //
  // Retrieves all available pairing rules from workspace and user settings.
  // Combines custom rules defined in both scopes for comprehensive rule selection.
  // 
  // @returns Array of all available pairing rules
  //
  public getAllPairingRules(): PairingRule[] {
    return [
      ...(PairingRuleService.getRules('workspace') ?? []),
      ...(PairingRuleService.getRules('user') ?? [])
    ];
  }

  //
  // Extracts custom C++ file extensions if custom rules are available.
  // Used for adapting default templates to match custom extension preferences.
  // 
  // @returns Custom extension configuration or null if none exists
  //
  public getCustomCppExtensions(): { headerExt: string, sourceExt: string } | null {
    const allRules = this.getAllPairingRules();
    const cppCustomRule = allRules.find(r => r.language === 'cpp');
    return cppCustomRule ? {
      headerExt: cppCustomRule.headerExt,
      sourceExt: cppCustomRule.sourceExt
    }
      : null;
  }

  //
  // Converts kebab-case or snake_case strings to PascalCase format.
  // Commonly used for generating class names from file names.
  // 
  // @param input - String to convert (e.g., "my-class" or "my_class")
  // @returns PascalCase string (e.g., "MyClass")
  //
  public toPascalCase(input: string): string {
    return input.split(/[-_]+/)
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join('');
  }

  //
  // Determines the appropriate placeholder text for input dialogs based on rule type.
  // Provides context-appropriate default names for different template types.
  // 
  // @param rule - The pairing rule that determines the placeholder type
  // @returns Appropriate placeholder string for the rule type
  //
  public getDefaultPlaceholder(rule: PairingRule): string {
    if (rule.isClass) {
      return DEFAULT_PLACEHOLDERS.CPP_CLASS;
    }

    if (rule.isStruct) {
      return rule.language === 'cpp' ? DEFAULT_PLACEHOLDERS.CPP_STRUCT
        : DEFAULT_PLACEHOLDERS.C_STRUCT;
    }

    return rule.language === 'c' ? DEFAULT_PLACEHOLDERS.C_EMPTY
      : DEFAULT_PLACEHOLDERS.CPP_EMPTY;
  }

  //
  // Determines the appropriate line ending format for the current platform.
  // Respects user preferences while providing sensible defaults.
  // 
  // @param eolSetting - VS Code EOL setting value
  // @returns Line ending string (\n or \r\n)
  //
  public getLineEnding(eolSetting?: string): string {
    return eolSetting === '\n' || eolSetting === '\r\n' ? eolSetting
      : process.platform === 'win32' ? '\r\n'
        : '\n';
  }

  //
  // Generates complete file content for both header and source files.
  // Selects appropriate templates based on rule characteristics and applies
  // variable substitution to create final file content.
  // 
  // @param fileName - Base name for the files (without extension)
  // @param eol - Line ending format to use
  // @param rule - Pairing rule defining template type and extensions
  // @returns Object containing both header and source file content
  //
  public generateFileContent(fileName: string, eol: string, rule: PairingRule): { headerContent: string; sourceContent: string; } {
    const templateKey: TemplateKey =
      rule.isClass ? 'CPP_CLASS'
        : rule.isStruct ? (rule.language === 'cpp' ? 'CPP_STRUCT' : 'C_STRUCT')
          : rule.language === 'c' ? 'C_EMPTY'
            : 'CPP_EMPTY';

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

  //
  // Performs template variable substitution using a simple regex-based approach.
  // Replaces {{variableName}} patterns with corresponding context values.
  // 
  // @param template - Template string containing {{variable}} placeholders
  // @param context - Object mapping variable names to replacement values
  // @returns Template with all variables substituted
  //
  private applyTemplate(template: string,
    context: Record<string, string>): string {
    // Pre-compile regex for better performance if used frequently
    return template.replace(/\{\{(\w+)\}\}/g, (_, key) => context[key] ?? '');
  }

  //
  // Checks if either the header or source file already exists at the target location.
  // Uses parallel checking for performance and returns the path of any existing file.
  // 
  // @param headerPath - URI of the proposed header file location
  // @param sourcePath - URI of the proposed source file location
  // @returns Path of existing file or null if both locations are available
  //
  public async checkFileExistence(headerPath: vscode.Uri,
    sourcePath: vscode.Uri):
    Promise<string | null> {
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

  //
  // Writes both header and source files to the file system concurrently.
  // Uses parallel writing for better performance and provides comprehensive error handling.
  // 
  // @param headerPath - URI where header file should be written
  // @param sourcePath - URI where source file should be written
  // @param headerContent - Content for the header file
  // @param sourceContent - Content for the source file
  // @throws Error with descriptive message if writing fails
  //
  public async writeFiles(headerPath: vscode.Uri, sourcePath: vscode.Uri,
    headerContent: string,
    sourceContent: string): Promise<void> {
    try {
      await Promise.all([
        vscode.workspace.fs.writeFile(headerPath,
          Buffer.from(headerContent, 'utf8')),
        vscode.workspace.fs.writeFile(sourcePath,
          Buffer.from(sourceContent, 'utf8'))
      ]);
    } catch (error) {
      throw new Error(`Failed to create files: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  //
  // Intelligently determines the target directory for new file creation.
  // Prioritizes the current file's directory, then single workspace folders.
  // Returns undefined for multiple workspace folders to trigger UI selection.
  // 
  // @param activeDocumentPath - Path of currently active document (if any)
  // @param workspaceFolders - Available workspace folders
  // @returns Target directory URI or undefined if UI selection needed
  //
  public async getTargetDirectory(activeDocumentPath?: string,
    workspaceFolders
      ?: readonly vscode.WorkspaceFolder[]):
    Promise<vscode.Uri | undefined> {
    // Prefer current file's directory
    if (activeDocumentPath) {
      return vscode.Uri.file(path.dirname(activeDocumentPath));
    }

    // Return single workspace folder directly
    if (workspaceFolders?.length === 1) {
      return workspaceFolders[0].uri;
    }

    // Multiple workspace folders require UI selection
    return undefined;
  }

  //
  // Determines whether to display a language mismatch warning to the user.
  // Implements business logic for detecting potential language/template conflicts.
  // Currently focuses on C context choosing C++ templates.
  // 
  // @param language - Detected programming language from current context
  // @param result - Selected pairing rule/template
  // @param currentDir - Current working directory path
  // @param activeFilePath - Path of currently active file
  // @param checkForCppFilesInDirectory - Function to check for C++ files in directory
  // @param fileExistsCheck - Function to check if files exist
  // @returns True if warning should be shown, false otherwise
  //
  public async shouldShowLanguageMismatchWarning(language: Language,
    result: PairingRule,
    currentDir?: string,
    activeFilePath?: string,
    checkForCppFilesInDirectory?: (dirPath: string) => Promise<boolean>,
    fileExistsCheck?: (path: string) => Promise<boolean>): Promise<boolean> {
    if (!currentDir || !activeFilePath) {
      return true;
    }

    // Only for C context choosing C++ template
    if (language === 'c' && result.language === 'cpp') {
      return checkForCppFilesInDirectory ?
        await checkForCppFilesInDirectory(currentDir) : true;
    }

    return this.checkForCorrespondingSourceFiles(currentDir, activeFilePath,
      language, fileExistsCheck);
  }

  //
  // Checks for the existence of corresponding source files in the same directory.
  // Used as part of the language mismatch warning logic to detect project context.
  // 
  // @param dirPath - Directory path to search in
  // @param filePath - Current file path for base name extraction
  // @param language - Programming language to check extensions for
  // @param fileExistsCheck - Function to check file existence
  // @returns True if warning should be shown (no corresponding files found)
  //
  private async checkForCorrespondingSourceFiles(
    dirPath: string, filePath: string, language: Language,
    fileExistsCheck?: (path: string) => Promise<boolean>): Promise<boolean> {
    if (!fileExistsCheck) {
      return true; // Show warning if can't check
    }

    const baseName = path.basename(filePath, path.extname(filePath));
    const extensions = language === 'c' ? ['.c'] : ['.cpp', '.cc', '.cxx'];

    const checks = extensions.map(ext => fileExistsCheck(
      path.join(dirPath, `${baseName}${ext}`)));

    try {
      const results = await Promise.all(checks);
      return !results.some(
        (exists: boolean) => exists); // Show warning if NO corresponding files found
    } catch {
      return true; // Show warning if can't check
    }
  }

  //
  // Static utility method for checking file existence with performance caching.
  // Implements a time-based cache to avoid repeated file system calls.
  // Moved from UI layer to maintain better separation of concerns.
  // 
  // @param filePath - Absolute path to file to check
  // @returns Promise resolving to true if file exists, false otherwise
  //
  private static fileStatCache = new Map<string, Promise<boolean>>();

  public static async fileExists(filePath: string): Promise<boolean> {
    if (PairCreatorService.fileStatCache.has(filePath)) {
      return PairCreatorService.fileStatCache.get(filePath)!;
    }

    const promise =
      Promise.resolve(vscode.workspace.fs.stat(vscode.Uri.file(filePath))
        .then(() => true, () => false));

    PairCreatorService.fileStatCache.set(filePath, promise);

    // Auto-clear cache entry after 5 seconds to prevent memory leaks
    setTimeout(() => PairCreatorService.fileStatCache.delete(filePath), 5000);

    return promise;
  }

  //
  // Static utility method for checking if a directory contains C++ files.
  // Used in language mismatch warning logic to understand project context.
  // Moved from UI layer to consolidate file system utilities in Service layer.
  // 
  // @param dirPath - Directory path to scan for C++ files
  // @returns Promise resolving to true if warning should be shown (no C++ files found)
  //
  public static async checkForCppFilesInDirectory(dirPath: string): Promise<boolean> {
    try {
      const entries =
        await vscode.workspace.fs.readDirectory(vscode.Uri.file(dirPath));
      const hasCppFiles =
        entries.some(([fileName, fileType]) =>
          fileType === vscode.FileType.File &&
          PairCreatorService.DEFINITIVE_EXTENSIONS.cpp.has(
            path.extname(fileName)));
      return !hasCppFiles; // Show warning if NO C++ files found
    } catch {
      return true; // Show warning if can't check
    }
  }
}

//
// UI LAYER - User Interface Management
// 
// PairCreatorUI handles all user interactions and VS Code API integrations.
// It maintains a clean separation from business logic by delegating all
// computational work to the Service layer and focusing purely on:
// - User input collection and validation
// - Dialog management and user feedback
// - Context gathering from VS Code environment
// - UI workflow orchestration
// 
// The UI layer never contains business logic - it only translates between
// user interactions and service layer operations.
//
class PairCreatorUI {
  private service: PairCreatorService;

  //
  // Constructs the UI layer with a reference to the service layer.
  // 
  // @param service - Service layer instance for business logic delegation
  //
  constructor(service: PairCreatorService) { this.service = service; }

  //
  // Generates context-appropriate placeholder text for file name input dialogs.
  // Uses current file name when available, applying proper case conventions.
  // 
  // @param rule - Pairing rule that determines naming conventions
  // @returns Placeholder string for input dialog
  //
  private getPlaceholder(rule: PairingRule): string {
    const activeEditor = vscode.window.activeTextEditor;

    if (activeEditor?.document && !activeEditor.document.isUntitled) {
      const fileName =
        path.basename(activeEditor.document.fileName,
          path.extname(activeEditor.document.fileName));
      return rule.language === 'c' ? fileName
        : this.service.toPascalCase(fileName);
    }

    return this.service.getDefaultPlaceholder(rule);
  }

  //
  // Determines the target directory for file creation with UI fallback handling.
  // Attempts service layer logic first, then handles multi-workspace scenarios
  // by presenting a selection dialog to the user.
  // 
  // @returns Selected target directory URI or undefined if cancelled
  //
  public async getTargetDirectory(): Promise<vscode.Uri | undefined> {
    const activeEditor = vscode.window.activeTextEditor;
    const activeDocumentPath =
      activeEditor?.document && !activeEditor.document.isUntitled
        ? activeEditor.document.uri.fsPath
        : undefined;
    const workspaceFolders = vscode.workspace.workspaceFolders;

    // Try service layer first
    const result = await this.service.getTargetDirectory(activeDocumentPath,
      workspaceFolders);
    if (result) {
      return result;
    }

    // Handle multiple workspace folders with UI
    if (workspaceFolders && workspaceFolders.length > 1) {
      const selected = await vscode.window.showWorkspaceFolderPick(
        { placeHolder: 'Select workspace folder for new files' });
      return selected?.uri;
    }

    return undefined;
  }

  //
  // Evaluates whether to show language mismatch warnings by gathering UI context.
  // Collects current editor information and delegates decision logic to service layer.
  // 
  // @param language - Detected programming language
  // @param result - Selected pairing rule
  // @returns True if warning should be displayed to user
  //
  private async shouldShowLanguageMismatchWarning(language: Language,
    result: PairingRule):
    Promise<boolean> {
    const activeEditor = vscode.window.activeTextEditor;
    const currentDir =
      activeEditor?.document && !activeEditor.document.isUntitled
        ? path.dirname(activeEditor.document.uri.fsPath)
        : undefined;
    const activeFilePath =
      activeEditor?.document && !activeEditor.document.isUntitled
        ? activeEditor.document.uri.fsPath
        : undefined;

    return this.service.shouldShowLanguageMismatchWarning(
      language, result, currentDir, activeFilePath,
      PairCreatorService.checkForCppFilesInDirectory,
      PairCreatorService.fileExists);
  }

  //
  // Detects the programming language from the currently active editor.
  // Gathers context from VS Code environment and delegates detection logic to service layer.
  // 
  // @returns Language detection result with uncertainty flag
  //
  public async detectLanguage():
    Promise<{ language: Language, uncertain: boolean }> {
    const activeEditor = vscode.window.activeTextEditor;
    const languageId = activeEditor?.document?.languageId;
    const filePath = activeEditor?.document && !activeEditor.document.isUntitled
      ? activeEditor.document.uri.fsPath
      : undefined;

    return this.service.detectLanguage(languageId, filePath, PairCreatorService.fileExists);
  }

  //
  // Retrieves the preferred line ending format from VS Code settings.
  // Delegates the determination logic to service layer while handling VS Code API access.
  // 
  // @returns Appropriate line ending string for current platform/settings
  //
  public getLineEnding(): string {
    const eolSetting = vscode.workspace.getConfiguration('files').get<string>('eol');
    return this.service.getLineEnding(eolSetting);
  }

  //
  // Adapts template rules for UI display by applying custom extension preferences.
  // Modifies rule descriptions to reflect actual file extensions that will be used.
  // 
  // @param rule - Original template rule
  // @returns Adapted rule with updated descriptions and extensions
  //
  private adaptRuleForDisplay(rule: PairingRule): PairingRule {
    if (rule.language !== 'cpp') {
      return rule;
    }

    const customExtensions = this.service.getCustomCppExtensions();
    if (!customExtensions) {
      return rule;
    }

    const { headerExt, sourceExt } = customExtensions;

    // Adapt description for display
    const replacementPattern =
      /Header\/Source|\.h(?:h|pp|xx)?\/\.c(?:pp|c|xx)?/g;
    const newDescription = rule.description.replace(
      replacementPattern, `${headerExt}/${sourceExt}`);

    return { ...rule, description: newDescription, headerExt, sourceExt };
  }

  //
  // Prepares and orders template choices for display in selection dialogs.
  // Implements intelligent ordering based on detected language and certainty level.
  // 
  // @param language - Detected programming language
  // @param uncertain - Whether language detection was uncertain
  // @returns Ordered array of template rules for display
  //
  private prepareTemplateChoices(language: 'c' | 'cpp',
    uncertain: boolean): PairingRule[] {
    const desiredOrder =
      uncertain
        ? ['cpp_empty', 'c_empty', 'cpp_class', 'cpp_struct', 'c_struct']
        : language === 'c'
          ? ['c_empty', 'c_struct', 'cpp_empty', 'cpp_class', 'cpp_struct']
          : ['cpp_empty', 'cpp_class', 'cpp_struct', 'c_empty', 'c_struct'];

    return [...TEMPLATE_RULES]
      .sort((a, b) =>
        desiredOrder.indexOf(a.key) - desiredOrder.indexOf(b.key))
      .map(rule => this.adaptRuleForDisplay(rule));
  }

  //
  // Processes custom rules and prepares them for UI display alongside default templates.
  // Handles complex logic for merging custom rules with adapted default templates
  // and organizing them by language and template type.
  // 
  // @param allRules - All available custom pairing rules
  // @param language - Current programming language context
  // @returns Organized rule collections for different UI sections
  //
  private prepareCustomRulesChoices(allRules: PairingRule[],
    language: 'c' | 'cpp'): {
      languageRules: PairingRule[],
      adaptedDefaultTemplates: PairingRule[],
      otherLanguageTemplates: PairingRule[],
      cleanedCustomRules: PairingRule[]
    } {
    const languageRules = allRules.filter(rule => rule.language === language);
    const customExt = languageRules.length > 0 ? languageRules[0] : null;

    let adaptedDefaultTemplates: PairingRule[] = [];

    if (customExt && language === 'cpp') {
      // For C++, adapt default templates with custom extensions
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
      // Standard adaptation for non-custom or C language
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
          .map(template => this.adaptRuleForDisplay(template));
    }

    const otherLanguageTemplates =
      TEMPLATE_RULES.filter(template => template.language !== language)
        .map(template => this.adaptRuleForDisplay(template));

    const cleanedCustomRules = allRules.map(
      rule => ({
        ...rule,
        label: rule.label.includes('$(')
          ? rule.label
          : `$(new-file) ${rule.language === 'cpp' ? 'C++' : 'C'} Pair (${rule.headerExt}/${rule.sourceExt})`,
        description: rule.description.startsWith('Creates a')
          ? rule.description
          : `Creates a ${rule.headerExt}/${rule.sourceExt} file pair with header guards.`
      }));

    return {
      languageRules,
      adaptedDefaultTemplates,
      otherLanguageTemplates,
      cleanedCustomRules
    };
  }

  //
  // Checks for existing custom pairing rules and offers creation options if none exist.
  // Implements the main decision logic for custom rule workflows:
  // - For C language: Always uses default templates
  // - For C++: Checks for existing rules and offers creation if uncertain
  // 
  // @param language - Detected programming language
  // @param uncertain - Whether language detection was uncertain
  // @returns Selected rule, null if cancelled, undefined for defaults, or 'use_default' flag
  //
  public async checkAndOfferCustomRules(language: 'c' | 'cpp',
    uncertain: boolean):
    Promise<PairingRule | null | undefined | 'use_default'> {
    if (language === 'c')
      return undefined; // Always use default C templates

    const allRules = this.service.getAllPairingRules();
    const languageRules = allRules.filter(rule => rule.language === language);

    if (languageRules.length > 0) {
      const result = await this.selectFromCustomRules(allRules, language);
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

  //
  // Presents a comprehensive selection dialog for custom pairing rules.
  // Combines custom rules with adapted default templates and cross-language options.
  // Includes a special option to fall back to default templates.
  // 
  // @param allRules - All available custom pairing rules
  // @param language - Current programming language context
  // @returns Selected rule, undefined if cancelled, or 'use_default' flag
  //
  public async selectFromCustomRules(allRules: PairingRule[],
    language: 'c' | 'cpp'):
    Promise<PairingRule | undefined | 'use_default'> {

    const {
      cleanedCustomRules,
      adaptedDefaultTemplates,
      otherLanguageTemplates
    } = this.prepareCustomRulesChoices(allRules, language);

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

  //
  // Displays an informational dialog offering to create custom pairing rules for C++.
  // Only applicable for C++ since C uses standard .c/.h extensions.
  // Provides user education about custom rule benefits.
  // 
  // @param language - Programming language (should be 'cpp' for meaningful operation)
  // @returns true to proceed with creation, false to dismiss, null if cancelled
  //
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

  //
  // Guides users through the complete custom pairing rule creation process.
  // Provides common extension combinations and allows custom input.
  // Handles rule persistence to workspace or global settings with error management.
  // 
  // @param language - Programming language (should be 'cpp' for meaningful operation)
  // @returns Created custom rule or undefined if cancelled/failed
  //
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

  //
  // Orchestrates the complete pairing rule selection process.
  // First attempts custom rule workflows, then falls back to default templates.
  // Includes language mismatch warning logic for better user experience.
  // 
  // @param language - Detected programming language
  // @param uncertain - Whether language detection was uncertain
  // @returns Selected pairing rule or undefined if cancelled
  //
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

    const choices = this.prepareTemplateChoices(language, uncertain);

    const result = await vscode.window.showQuickPick(choices, {
      placeHolder: 'Please select the type of file pair to create.',
      title: 'Create Source/Header Pair'
    });

    if (result && language === 'c' && result.language === 'cpp') {
      const shouldShowWarning =
        await this.shouldShowLanguageMismatchWarning(language, result);

      if (shouldShowWarning) {
        const shouldContinue = await vscode.window.showWarningMessage(
          `You're working in a C file but selected a C++ template. This may create files with incompatible extensions or content.`,
          'Continue', 'Cancel');

        if (shouldContinue !== 'Continue')
          return undefined;
      }
    }

    return result;
  }

  //
  // Prompts user to enter a name for the new file pair with comprehensive validation.
  // Provides context-appropriate prompts and validates input as valid C/C++ identifiers.
  // Uses intelligent placeholder generation based on current context.
  // 
  // @param rule - Selected pairing rule that determines prompt message and validation
  // @returns Entered file name or undefined if cancelled/invalid
  //
  public async promptForFileName(rule: PairingRule): Promise<string | undefined> {
    const prompt = rule.isClass ? 'Please enter the name for the new C++ class.'
      : rule.isStruct
        ? `Please enter the name for the new ${rule.language.toUpperCase()} struct.`
        : `Please enter the base name for the new ${rule.language.toUpperCase()} file pair.`;

    return vscode.window.showInputBox({
      prompt,
      placeHolder: this.getPlaceholder(rule),
      validateInput: (text) =>
        VALIDATION_PATTERNS.IDENTIFIER.test(text?.trim() || '')
          ? null
          : 'Invalid C/C++ identifier.',
      title: 'Create Source/Header Pair'
    });
  }

  //
  // Displays success notification and opens the newly created header file for editing.
  // Provides immediate feedback to user and sets them up for productive work.
  // 
  // @param headerPath - URI of the created header file
  // @param sourcePath - URI of the created source file
  //
  public async showSuccessAndOpenFile(headerPath: vscode.Uri,
    sourcePath: vscode.Uri): Promise<void> {
    await vscode.window.showTextDocument(
      await vscode.workspace.openTextDocument(headerPath));
    await vscode.window.showInformationMessage(
      `Successfully created ${path.basename(headerPath.fsPath)} and ${path.basename(sourcePath.fsPath)}.`);
  }
}

//
// COORDINATOR LAYER - Workflow Orchestration
// 
// CreatePairCoordinator serves as the main entry point and orchestrates the complete
// file pair creation workflow. It coordinates between the UI and Service layers
// without performing any creation logic itself.
// 
// Key Responsibilities:
// - Command registration and lifecycle management
// - High-level workflow orchestration
// - Error handling and user feedback
// - Resource cleanup and disposal
// 
// The coordinator implements the Command Pattern and serves as the main
// integration point between VS Code's command system and the application logic.
//
class CreatePairCoordinator implements vscode.Disposable {
  private command: vscode.Disposable;
  private service: PairCreatorService;
  private ui: PairCreatorUI;

  //
  // Initializes the coordinator and registers the VS Code command.
  // Sets up the complete three-layer architecture with proper dependencies.
  //
  constructor() {
    this.service = new PairCreatorService();
    this.ui = new PairCreatorUI(this.service);
    this.command = vscode.commands.registerCommand(
      'clangd.createSourceHeaderPair', this.create, this);
  }

  //
  // Cleanup method for proper resource disposal when extension is deactivated.
  // Ensures VS Code command is properly unregistered.
  //
  dispose() { this.command.dispose(); }

  //
  // Main entry point for the file pair creation process.
  // Orchestrates the complete workflow using UI and Service layers:
  // 1. Target directory determination
  // 2. Language detection and template selection
  // 3. File name collection and validation
  // 4. File existence checking
  // 5. Content generation and file writing
  // 6. Success feedback and file opening
  // 
  // Provides comprehensive error handling with user-friendly messages.
  //
  public async create(): Promise<void> {
    try {
      const targetDirectory = await this.ui.getTargetDirectory();
      if (!targetDirectory) {
        vscode.window.showErrorMessage(
          'Cannot determine target directory. Please open a folder or a file first.');
        return;
      }

      const { language, uncertain } = await this.ui.detectLanguage();
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

      const eol = this.ui.getLineEnding();
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

// Command registration function to integrate with VS Code extension system.
export function registerCreateSourceHeaderPairCommand(context: ClangdContext) {
  context.subscriptions.push(new CreatePairCoordinator());
}
