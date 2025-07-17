// src/pairing-rule-ui.ts

import * as vscode from 'vscode';
import * as PairingRuleService from './pairing-rule-service'; // Import the service

// Main entry point for the configuration UI
export async function showConfigurationWizard() {
    const quickPick = vscode.window.createQuickPick();
    quickPick.title = 'Configure Source/Header Pairing Rules';
    quickPick.items = buildMenuItems();

    quickPick.onDidChangeSelection(async (selection) => {
        if (selection[0]) {
            const key = (selection[0] as any).key;
            await handleMenuSelection(key);
            quickPick.hide();
        }
    });

    quickPick.onDidHide(() => quickPick.dispose());
    quickPick.show();
}

// Builds the list of items to show in the Quick Pick menu
function buildMenuItems(): (vscode.QuickPickItem | (vscode.QuickPickItem & { key: string }))[] {
    const menuItems: (vscode.QuickPickItem | (vscode.QuickPickItem & { key: string }))[] = [];

    // Add items for managing workspace settings
    menuItems.push({
        label: '$(edit) Edit Workspace Pairing Rules',
        description: 'Manually edit the rules in .vscode/settings.json',
        key: 'edit_workspace'
    });

    if (PairingRuleService.getRules('workspace')) {
        menuItems.push({
            label: '$(clear-all) Reset Workspace Pairing Rules',
            description: 'Remove the rules from the workspace settings to use global or default rules.',
            key: 'reset_workspace'
        });
    }

    // Add a separator
    menuItems.push({
        label: 'Global Settings',
        kind: vscode.QuickPickItemKind.Separator
    });

    // Add items for managing global settings
    menuItems.push({
        label: '$(edit) Edit Global Pairing Rules',
        description: 'Manually edit your user-level settings.json',
        key: 'edit_global'
    });

    if (PairingRuleService.getRules('user')) {
        menuItems.push({
            label: '$(clear-all) Reset Global Pairing Rules',
            description: 'Remove the rules from your global settings to use the extension defaults.',
            key: 'reset_global'
        });
    }

    return menuItems;
}

// Handles the logic when a user selects an item from the menu
async function handleMenuSelection(key: string) {
    switch (key) {
        case 'edit_workspace':
            await openSettingsFile('workspace');
            break;
        case 'reset_workspace':
            await PairingRuleService.resetRules('workspace');
            vscode.window.showInformationMessage('Workspace pairing rules have been reset.');
            break;
        case 'edit_global':
            await openSettingsFile('user');
            break;
        case 'reset_global':
            await PairingRuleService.resetRules('user');
            vscode.window.showInformationMessage('Global pairing rules have been reset.');
            break;
    }
}

// A helper function to open the correct settings.json file
async function openSettingsFile(scope: 'workspace' | 'user') {
    const command = scope === 'workspace'
        ? 'workbench.action.openWorkspaceSettingsFile'
        : 'workbench.action.openSettingsJson';

    await vscode.commands.executeCommand(command);
}