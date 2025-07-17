// src/pairing-rule-manager.ts

import * as vscode from 'vscode';

// --- Public Interface and Types ---

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

// --- Configuration Service Class ---

/**
 * Handles all configuration management for pairing rules.
 * Responsible for reading, writing, and managing VS Code settings.
 */
export class PairingRuleService {
    private static readonly CONFIG_KEY = 'createPair.rules';

    /**
     * Gets the currently active pairing rules, respecting the configuration hierarchy.
     * Priority: Workspace > User (Global) > Extension Default.
     * @returns A readonly array of the currently effective PairingRule objects.
     */
    public static getActiveRules(): ReadonlyArray<PairingRule> {
        const config = vscode.workspace.getConfiguration('clangd');
        return config.get<PairingRule[]>(PairingRuleService.CONFIG_KEY, []);
    }

    /**
     * Checks if a custom configuration exists at the specified scope.
     * @param scope The configuration scope to check.
     * @returns True if a custom rule set exists, false otherwise.
     */
    public static hasCustomRules(scope: 'workspace' | 'user'): boolean {
        const config = vscode.workspace.getConfiguration('clangd');
        const inspection = config.inspect<PairingRule[]>(PairingRuleService.CONFIG_KEY);
        const value = scope === 'workspace' ? inspection?.workspaceValue : inspection?.globalValue;
        // It's custom if the value is defined and is an array (even an empty one).
        return Array.isArray(value);
    }

    /**
     * Reads the pairing rules from the specified configuration scope.
     * @param scope The scope to read from ('workspace' or 'user').
     * @returns An array of PairingRule objects, or undefined if not set.
     */
    public static getRules(scope: 'workspace' | 'user'): PairingRule[] | undefined {
        const config = vscode.workspace.getConfiguration('clangd');
        const inspection = config.inspect<PairingRule[]>(PairingRuleService.CONFIG_KEY);

        return scope === 'workspace'
            ? inspection?.workspaceValue
            : inspection?.globalValue;
    }

    /**
     * Writes a given set of rules to the specified configuration scope, overwriting any existing rules.
     * @param rules The array of rules to write.
     * @param scope The scope to write to ('workspace' or 'user').
     */
    public static async writeRules(rules: PairingRule[], scope: 'workspace' | 'user'): Promise<void> {
        const target = scope === 'workspace'
            ? vscode.ConfigurationTarget.Workspace
            : vscode.ConfigurationTarget.Global;
        await vscode.workspace.getConfiguration('clangd').update(PairingRuleService.CONFIG_KEY, rules, target);
    }

    /**
     * Resets the pairing rules by removing them from the specified configuration scope.
     * This causes VS Code to fall back to the next configuration level (e.g., global or default).
     * @param scope The configuration scope to reset.
     */
    public static async resetRules(scope: 'workspace' | 'user'): Promise<void> {
        const target = scope === 'workspace'
            ? vscode.ConfigurationTarget.Workspace
            : vscode.ConfigurationTarget.Global;
        // To reset a setting, we update its value to 'undefined'.
        await vscode.workspace.getConfiguration('clangd').update(PairingRuleService.CONFIG_KEY, undefined, target);
    }
}

// --- User Interface Class ---

/**
 * Handles all user interface interactions for pairing rule management.
 * Responsible for displaying QuickPick menus and handling user selections.
 */
export class PairingRuleUI {

    // Predefined extension combinations that users can choose from
    private static readonly EXTENSION_OPTIONS = [
        { label: '.h / .cpp', description: 'Standard C++ extensions', headerExt: '.h', sourceExt: '.cpp', language: 'cpp' as const },
        { label: '.hh / .cc', description: 'Alternative C++ extensions', headerExt: '.hh', sourceExt: '.cc', language: 'cpp' as const },
        { label: '.hpp / .cpp', description: 'Header Plus Plus style', headerExt: '.hpp', sourceExt: '.cpp', language: 'cpp' as const },
        { label: '.hxx / .cxx', description: 'Extended C++ extensions', headerExt: '.hxx', sourceExt: '.cxx', language: 'cpp' as const },
        { label: '.h / .c', description: 'Standard C extensions', headerExt: '.h', sourceExt: '.c', language: 'c' as const }
    ];

    /**
     * Shows the main configuration wizard to the user.
     * It allows quick setup of file extension preferences.
     */
    public static async showConfigurationWizard(): Promise<void> {
        const ruleChoices = PairingRuleUI.createRuleChoices();
        const advancedOptions = PairingRuleUI.createAdvancedOptions();

        const quickPick = PairingRuleUI.createMainQuickPick();
        quickPick.items = [...ruleChoices, ...advancedOptions];

        quickPick.onDidChangeSelection(async (selection) => {
            if (!selection[0]) return;
            quickPick.hide();

            const selectedItem = selection[0] as any;
            if (selectedItem.rule) {
                await PairingRuleUI.handleRuleSelection(selectedItem.rule);
            } else if (selectedItem.key === 'advanced_options') {
                await PairingRuleUI.showAdvancedManagementMenu();
            }
        });

        quickPick.onDidHide(() => quickPick.dispose());
        quickPick.show();
    }

    /**
     * Shows the advanced menu for manual editing and resetting.
     */
    public static async showAdvancedManagementMenu(): Promise<void> {
        const menuItems = PairingRuleUI.createAdvancedMenuItems();
        const selection = await vscode.window.showQuickPick(menuItems, {
            title: 'Advanced Rule Management'
        });

        if (!selection) return;

        await PairingRuleUI.handleAdvancedMenuSelection(selection.key);
    }

    // --- Private Helper Methods ---

    /**
     * Creates rule choice items from the predefined extension options.
     */
    private static createRuleChoices(): Array<vscode.QuickPickItem & { rule: PairingRule }> {
        return PairingRuleUI.EXTENSION_OPTIONS.map((option, index) => ({
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

    /**
     * Creates the advanced options section for the main menu.
     */
    private static createAdvancedOptions(): Array<vscode.QuickPickItem & { key: string }> {
        return [
            { label: 'Advanced Management', kind: vscode.QuickPickItemKind.Separator, key: 'separator' },
            { label: '$(settings-gear) Advanced Options...', description: 'Edit or reset rules manually', key: 'advanced_options' }
        ];
    }

    /**
     * Creates the main QuickPick control with appropriate settings.
     */
    private static createMainQuickPick(): vscode.QuickPick<vscode.QuickPickItem> {
        const quickPick = vscode.window.createQuickPick();
        quickPick.title = 'Quick Setup: Choose File Extensions';
        quickPick.placeholder = 'Choose file extension combination for this workspace, or go to advanced options.';
        return quickPick;
    }

    /**
     * Creates menu items for the advanced management interface.
     */
    private static createAdvancedMenuItems(): Array<vscode.QuickPickItem & { key: string }> {
        const menuItems: Array<vscode.QuickPickItem & { key: string }> = [];

        // Workspace section
        menuItems.push({
            label: '$(edit) Edit Workspace Rules...',
            description: 'Opens .vscode/settings.json',
            key: 'edit_workspace'
        });

        if (PairingRuleService.hasCustomRules('workspace')) {
            menuItems.push({
                label: '$(clear-all) Reset Workspace Rules',
                description: 'Use global or default rules instead.',
                key: 'reset_workspace'
            });
        }

        // Global section
        menuItems.push({
            label: 'Global (User) Settings',
            kind: vscode.QuickPickItemKind.Separator,
            key: 'separator_global'
        });

        menuItems.push({
            label: '$(edit) Edit Global Rules...',
            description: 'Opens your global settings.json',
            key: 'edit_global'
        });

        if (PairingRuleService.hasCustomRules('user')) {
            menuItems.push({
                label: '$(clear-all) Reset Global Rules',
                description: 'Use the extension default rules instead.',
                key: 'reset_global'
            });
        }

        return menuItems;
    }

    /**
     * Handles the logic after a user picks a rule for quick setup.
     * Asks where to save the configuration.
     */
    private static async handleRuleSelection(rule: PairingRule): Promise<void> {
        const scope = await vscode.window.showQuickPick([
            {
                label: 'Save for this Workspace',
                description: 'Recommended. Creates a .vscode/settings.json file.',
                scope: 'workspace'
            },
            {
                label: 'Save for all my Projects (Global)',
                description: 'Modifies your global user settings.',
                scope: 'user'
            }
        ], {
            placeHolder: 'Where would you like to save this rule?',
            title: 'Save Configuration Scope'
        });

        if (!scope) return;

        await PairingRuleService.writeRules([rule], scope.scope as 'workspace' | 'user');
        vscode.window.showInformationMessage(
            `Successfully set '${rule.label}' as the default extension for the ${scope.scope}.`
        );
    }

    /**
     * Handles advanced menu selections by executing the appropriate actions.
     */
    private static async handleAdvancedMenuSelection(key: string): Promise<void> {
        switch (key) {
            case 'edit_workspace':
                await vscode.commands.executeCommand('workbench.action.openWorkspaceSettingsFile');
                break;
            case 'reset_workspace':
                await PairingRuleService.resetRules('workspace');
                vscode.window.showInformationMessage('Workspace pairing rules have been reset.');
                break;
            case 'edit_global':
                await vscode.commands.executeCommand('workbench.action.openSettingsJson');
                break;
            case 'reset_global':
                await PairingRuleService.resetRules('user');
                vscode.window.showInformationMessage('Global pairing rules have been reset.');
                break;
        }
    }
}

// --- Backward Compatibility Exports ---

// Export the UI function for backward compatibility
export const showConfigurationWizard = PairingRuleUI.showConfigurationWizard;
