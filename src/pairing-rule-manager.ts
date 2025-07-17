import * as vscode from 'vscode';

// Public interface for pairing rules
export interface PairingRule {
    key: string;
    label: string;
    description: string;
    language: 'c' | 'cpp';
    headerExt: string;
    sourceExt: string;
    isClass?: boolean;
    isStruct?: boolean;
}

// Type aliases for QuickPick items
type RuleQuickPickItem = vscode.QuickPickItem & { rule: PairingRule };
type ActionQuickPickItem = vscode.QuickPickItem & { key: string };

// Configuration management namespace
export namespace PairingRuleService {
    const CONFIG_KEY = 'createPair.rules';

    // Validate a single pairing rule
    function validateRule(rule: PairingRule): void {
        if (!rule.key || !rule.language || !rule.headerExt || !rule.sourceExt) {
            throw new Error(`Invalid rule: ${JSON.stringify(rule)}`);
        }
    }

    // Show error message and re-throw
    function handleError(error: unknown, operation: string, scope: string): never {
        const message = `Failed to ${operation} pairing rules for ${scope}: ${error instanceof Error ? error.message : 'Unknown error'}`;
        vscode.window.showErrorMessage(message);
        throw error;
    }

    export function getActiveRules(): ReadonlyArray<PairingRule> {
        return vscode.workspace.getConfiguration('clangd').get<PairingRule[]>(CONFIG_KEY, []);
    }

    export function hasCustomRules(scope: 'workspace' | 'user'): boolean {
        const inspection = vscode.workspace.getConfiguration('clangd').inspect<PairingRule[]>(CONFIG_KEY);
        const value = scope === 'workspace' ? inspection?.workspaceValue : inspection?.globalValue;
        return Array.isArray(value);
    }

    export function getRules(scope: 'workspace' | 'user'): PairingRule[] | undefined {
        const inspection = vscode.workspace.getConfiguration('clangd').inspect<PairingRule[]>(CONFIG_KEY);
        return scope === 'workspace' ? inspection?.workspaceValue : inspection?.globalValue;
    }

    export async function writeRules(rules: PairingRule[], scope: 'workspace' | 'user'): Promise<void> {
        try {
            if (!Array.isArray(rules)) throw new Error('Rules must be an array');
            rules.forEach(validateRule);

            const target = scope === 'workspace' ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
            await vscode.workspace.getConfiguration('clangd').update(CONFIG_KEY, rules, target);
        } catch (error) {
            handleError(error, 'save', scope);
        }
    }

    export async function resetRules(scope: 'workspace' | 'user'): Promise<void> {
        try {
            const target = scope === 'workspace' ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
            await vscode.workspace.getConfiguration('clangd').update(CONFIG_KEY, undefined, target);
        } catch (error) {
            handleError(error, 'reset', scope);
        }
    }
}

// User interface management namespace
export namespace PairingRuleUI {
    // Predefined extension combinations
    const EXTENSION_OPTIONS = [
        { label: '.h / .cpp', description: 'Standard C++ extensions', headerExt: '.h', sourceExt: '.cpp', language: 'cpp' as const },
        { label: '.hh / .cc', description: 'Alternative C++ extensions', headerExt: '.hh', sourceExt: '.cc', language: 'cpp' as const },
        { label: '.hpp / .cpp', description: 'Header Plus Plus style', headerExt: '.hpp', sourceExt: '.cpp', language: 'cpp' as const },
        { label: '.hxx / .cxx', description: 'Extended C++ extensions', headerExt: '.hxx', sourceExt: '.cxx', language: 'cpp' as const },
    ];

    // Create rule choices from extension options
    function createRuleChoices(): RuleQuickPickItem[] {
        return EXTENSION_OPTIONS.map((option, index) => ({
            label: `$(file-code) ${option.label}`,
            description: option.description,
            rule: {
                key: `custom_${option.language}_${index}`,
                label: `${option.language.toUpperCase()} Pair (${option.headerExt}/${option.sourceExt})`,
                description: `Creates a ${option.headerExt}/${option.sourceExt} file pair with header guards.`,
                language: option.language,
                headerExt: option.headerExt,
                sourceExt: option.sourceExt
            }
        }));
    }

    // Create advanced options separator and menu item
    function createAdvancedOptions(): ActionQuickPickItem[] {
        return [
            { label: 'Advanced Management', kind: vscode.QuickPickItemKind.Separator, key: 'separator' },
            { label: '$(settings-gear) Advanced Options...', description: 'Edit or reset rules manually', key: 'advanced_options' }
        ];
    }

    // Create advanced menu items based on current settings
    function createAdvancedMenuItems(): ActionQuickPickItem[] {
        const items: ActionQuickPickItem[] = [
            { label: '$(edit) Edit Workspace Rules...', description: 'Opens .vscode/settings.json', key: 'edit_workspace' }
        ];

        if (PairingRuleService.hasCustomRules('workspace')) {
            items.push({ label: '$(clear-all) Reset Workspace Rules', description: 'Use global or default rules instead', key: 'reset_workspace' });
        }

        items.push(
            { label: 'Global (User) Settings', kind: vscode.QuickPickItemKind.Separator, key: 'separator_global' },
            { label: '$(edit) Edit Global Rules...', description: 'Opens your global settings.json', key: 'edit_global' }
        );

        if (PairingRuleService.hasCustomRules('user')) {
            items.push({ label: '$(clear-all) Reset Global Rules', description: 'Use the extension default rules instead', key: 'reset_global' });
        }

        return items;
    }

    // Handle rule selection and ask for save scope
    async function handleRuleSelection(rule: PairingRule): Promise<void> {
        const selection = await vscode.window.showQuickPick([
            { label: 'Save for this Workspace', description: 'Recommended. Creates a .vscode/settings.json file.', scope: 'workspace' },
            { label: 'Save for all my Projects (Global)', description: 'Modifies your global user settings.', scope: 'user' }
        ], {
            placeHolder: 'Where would you like to save this rule?',
            title: 'Save Configuration Scope'
        });

        if (!selection) return;

        await PairingRuleService.writeRules([rule], selection.scope as 'workspace' | 'user');
        vscode.window.showInformationMessage(`Successfully set '${rule.label}' as the default extension for the ${selection.scope}.`);
    }

    // Handle advanced menu selection
    async function handleAdvancedMenuSelection(key: string): Promise<void> {
        const actions = {
            edit_workspace: () => vscode.commands.executeCommand('workbench.action.openWorkspaceSettingsFile'),
            edit_global: () => vscode.commands.executeCommand('workbench.action.openSettingsJson'),
            reset_workspace: async () => {
                await PairingRuleService.resetRules('workspace');
                vscode.window.showInformationMessage('Workspace pairing rules have been reset.');
            },
            reset_global: async () => {
                await PairingRuleService.resetRules('user');
                vscode.window.showInformationMessage('Global pairing rules have been reset.');
            }
        };

        const action = actions[key as keyof typeof actions];
        if (action) await action();
    }

    // Main configuration wizard
    export async function showConfigurationWizard(): Promise<void> {
        const quickPick = vscode.window.createQuickPick<RuleQuickPickItem | ActionQuickPickItem>();
        quickPick.title = 'Quick Setup: Choose File Extensions';
        quickPick.placeholder = 'Choose file extension combination for this workspace, or go to advanced options.';
        quickPick.items = [...createRuleChoices(), ...createAdvancedOptions()];

        quickPick.onDidChangeSelection(async (selection) => {
            if (!selection[0]) return;
            quickPick.hide();

            const item = selection[0];
            if ('rule' in item) {
                await handleRuleSelection(item.rule);
            } else if (item.key === 'advanced_options') {
                await showAdvancedManagementMenu();
            }
        });

        quickPick.onDidHide(() => quickPick.dispose());
        quickPick.show();
    }

    // Advanced management menu
    export async function showAdvancedManagementMenu(): Promise<void> {
        const selection = await vscode.window.showQuickPick(createAdvancedMenuItems(), {
            title: 'Advanced Rule Management'
        });

        if (selection?.key) {
            await handleAdvancedMenuSelection(selection.key);
        }
    }
}

// Backward compatibility export
export const showConfigurationWizard = PairingRuleUI.showConfigurationWizard;