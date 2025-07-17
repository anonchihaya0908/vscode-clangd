// src/pairing-rule-ui.ts

import * as vscode from 'vscode';
import * as PairingRuleService from './pairing-rule-service';
import { PairingRule } from './pairing-rule-service';

// --- Main Entry Point for the UI ---

/**
 * Shows the main configuration wizard to the user.
 * It allows quick setup or navigation to advanced management options.
 */
export async function showConfigurationWizard() {
    const allDefaultRules = PairingRuleService.DEFAULT_TEMPLATE_RULES;

    // Create Quick Pick items from the default rules for quick setup
    const ruleChoices = allDefaultRules.map(rule => ({
        label: rule.label,
        description: rule.description,
        rule: rule
    }));

    // Add separator and management actions
    const advancedOptions = [
        { label: 'Advanced Management', kind: vscode.QuickPickItemKind.Separator },
        { label: '$(settings-gear) Advanced Options...', description: 'Edit or reset rules manually', key: 'advanced_options' }
    ];

    const quickPick = vscode.window.createQuickPick<(vscode.QuickPickItem & { rule?: PairingRule; key?: string })>();
    quickPick.title = 'Quick Setup: Select a Default Pairing Rule';
    quickPick.items = [...ruleChoices, ...advancedOptions];
    quickPick.placeholder = 'Choose a rule to set as the default for this workspace, or go to advanced options.';

    quickPick.onDidChangeSelection(async (selection) => {
        if (!selection[0]) return;

        quickPick.hide();

        if (selection[0].rule) {
            // User selected a rule for quick setup
            await handleRuleSelection(selection[0].rule);
        } else if ((selection[0] as any).key === 'advanced_options') {
            // User wants to go to the advanced menu
            await showAdvancedManagementMenu();
        }
    });

    quickPick.onDidHide(() => quickPick.dispose());
    quickPick.show();
}

// --- Helper Functions for UI Logic ---

/**
 * Handles the logic after a user picks a rule for quick setup.
 * Asks where to save the configuration.
 */
async function handleRuleSelection(rule: PairingRule) {
    const scope = await vscode.window.showQuickPick(
        [
            { label: 'Save for this Workspace', description: 'Recommended. Creates a .vscode/settings.json file.', scope: 'workspace' },
            { label: 'Save for all my Projects (Global)', description: 'Modifies your global user settings.', scope: 'user' }
        ],
        { placeHolder: 'Where would you like to save this rule?', title: 'Save Configuration Scope' }
    );

    if (!scope) return;

    await PairingRuleService.writeRules([rule], scope.scope as 'workspace' | 'user');
    vscode.window.showInformationMessage(`Successfully set '${rule.label}' as the default for the ${scope.scope}.`);
}

/**
 * Shows the advanced menu for manual editing and resetting.
 */
async function showAdvancedManagementMenu() {
    const menuItems: (vscode.QuickPickItem & { key: string })[] = [];

    menuItems.push({ label: '$(edit) Edit Workspace Rules...', description: 'Opens .vscode/settings.json', key: 'edit_workspace' });
    if (PairingRuleService.hasCustomRules('workspace')) {
        menuItems.push({ label: '$(clear-all) Reset Workspace Rules', description: 'Use global or default rules instead.', key: 'reset_workspace' });
    }

    menuItems.push({ label: 'Global (User) Settings', kind: vscode.QuickPickItemKind.Separator, key: 'separator_global' });

    menuItems.push({ label: '$(edit) Edit Global Rules...', description: 'Opens your global settings.json', key: 'edit_global' });
    if (PairingRuleService.hasCustomRules('user')) {
        menuItems.push({ label: '$(clear-all) Reset Global Rules', description: 'Use the extension default rules instead.', key: 'reset_global' });
    }

    const selection = await vscode.window.showQuickPick(menuItems, { title: 'Advanced Rule Management' });

    if (!selection) return;

    switch (selection.key) {
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