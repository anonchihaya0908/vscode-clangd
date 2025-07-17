// src/pairing-rule-service.ts

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

// --- Constants ---

const CONFIG_KEY = 'createPair.rules';

// The single source of truth for the extension's default rules.
// This is used as a fallback when no user or workspace configuration is found.
export const DEFAULT_TEMPLATE_RULES: ReadonlyArray<PairingRule> = [
    { key: 'cpp_empty', label: 'Empty C++ Pair', description: 'Creates basic .h/.cpp files.', language: 'cpp', headerExt: '.h', sourceExt: '.cpp' },
    { key: 'cpp_class', label: 'C++ Class', description: 'Creates a .h/.cpp pair with a class boilerplate.', language: 'cpp', headerExt: '.h', sourceExt: '.cpp', isClass: true },
    { key: 'cpp_struct', label: 'C++ Struct', description: 'Creates a .h/.cpp pair with a struct boilerplate.', language: 'cpp', headerExt: '.h', sourceExt: '.cpp', isStruct: true },
    { key: 'c_empty', label: 'Empty C Pair', description: 'Creates basic .h/.c files for functions.', language: 'c', headerExt: '.h', sourceExt: '.c' },
    { key: 'c_struct', label: 'C Struct', description: 'Creates a .h/.c pair with a typedef struct.', language: 'c', headerExt: '.h', sourceExt: '.c', isStruct: true }
];

// --- Service API ---

/**
 * Gets the currently active pairing rules, respecting the configuration hierarchy.
 * Priority: Workspace > User (Global) > Extension Default.
 * @returns A readonly array of the currently effective PairingRule objects.
 */
export function getActiveRules(): ReadonlyArray<PairingRule> {
    const config = vscode.workspace.getConfiguration('clangd');
    return config.get<PairingRule[]>(CONFIG_KEY, [...DEFAULT_TEMPLATE_RULES]);
}

/**
 * Checks if a custom configuration exists at the specified scope.
 * @param scope The configuration scope to check.
 * @returns True if a custom rule set exists, false otherwise.
 */
export function hasCustomRules(scope: 'workspace' | 'user'): boolean {
    const config = vscode.workspace.getConfiguration('clangd');
    const inspection = config.inspect<PairingRule[]>(CONFIG_KEY);
    const value = scope === 'workspace' ? inspection?.workspaceValue : inspection?.globalValue;
    // It's custom if the value is defined and is an array (even an empty one).
    return Array.isArray(value);
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
 * Writes a given set of rules to the specified configuration scope, overwriting any existing rules.
 * @param rules The array of rules to write.
 * @param scope The scope to write to ('workspace' or 'user').
 */
export async function writeRules(rules: PairingRule[], scope: 'workspace' | 'user'): Promise<void> {
    const target = scope === 'workspace'
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
    await vscode.workspace.getConfiguration('clangd').update(CONFIG_KEY, rules, target);
}

/**
 * Resets the pairing rules by removing them from the specified configuration scope.
 * This causes VS Code to fall back to the next configuration level (e.g., global or default).
 * @param scope The configuration scope to reset.
 */
export async function resetRules(scope: 'workspace' | 'user'): Promise<void> {
    const target = scope === 'workspace'
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
    // To reset a setting, we update its value to 'undefined'.
    await vscode.workspace.getConfiguration('clangd').update(CONFIG_KEY, undefined, target);
}