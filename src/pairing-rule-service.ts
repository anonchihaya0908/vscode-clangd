// src/pairing-rules.service.ts

import * as vscode from 'vscode';

// The data structure for a single pairing rule.
// This should be kept in sync with the one in create-source-header-pair.ts
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

// The key for the setting in settings.json
const CONFIG_KEY = 'createPair.rules';

// A helper to get the full namespaced key
function getConfigKey(): string {
    // Assuming your extension's name in package.json is 'clangd'
    return `clangd.${CONFIG_KEY}`;
}

/**
 * Reads the pairing rules from the specified configuration scope.
 * @param scope The scope to read from ('workspace' or 'user').
 * @returns An array of PairingRule objects, or undefined if not set.
 */
export function getRules(scope: 'workspace' | 'user'): PairingRule[] | undefined {
    const config = vscode.workspace.getConfiguration('clangd');
    // inspect() allows us to get the value from a specific scope.
    const inspection = config.inspect<PairingRule[]>(CONFIG_KEY);

    return scope === 'workspace'
        ? inspection?.workspaceValue
        : inspection?.globalValue;
}

/**
 * Writes a given set of pairing rules to the specified configuration scope.
 * @param rules The array of rules to write.
 * @param scope The scope to write to ('workspace' or 'user').
 */
export async function writeRules(rules: PairingRule[], scope: 'workspace' | 'user'): Promise<void> {
    const target = scope === 'workspace'
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;

    const config = vscode.workspace.getConfiguration('clangd');
    await config.update(CONFIG_KEY, rules, target);
}

/**
 * Resets the pairing rules by removing them from the specified configuration scope.
 * This causes the application to fall back to the next level (e.g., global or default).
 * @param scope The scope to reset ('workspace' or 'user').
 */
export async function resetRules(scope: 'workspace' | 'user'): Promise<void> {
    // To reset, we update the value to 'undefined'.
    const target = scope === 'workspace'
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;

    const config = vscode.workspace.getConfiguration('clangd');
    await config.update(CONFIG_KEY, undefined, target);
}