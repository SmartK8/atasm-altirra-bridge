/* eslint-disable @typescript-eslint/naming-convention */
"use strict";
import * as vscode from 'vscode';
import * as filesystem from './filesystem';
const os = require("os");
import * as path from 'path';
import * as fs from 'fs';
import * as util from 'util';

import { AssemblerRunnerBase } from './assembler/AssemblerRunnerBase';
import { AtasmAssemblerRunner } from './assembler/AtasmAssemblerRunner';
import { MadsAssemblerRunner } from './assembler/MadsAssemblerRunner';

import { EmulatorRunner } from './emulators/EmulatorRunner';

import { AsmSymbolProvider } from './explorer/asmSymbols';

export const OSPlatform: any = os.platform();
export const OSArch: any = os.arch();
export const IsWindows: boolean = (os.platform() === 'win32');
export const IsLinux: boolean = (os.platform() === 'linux');
export const IsMacOS: boolean = (os.platform() === 'darwin');
export const Is32Bit: boolean = (os.arch() === 'x32');
export const Is64Bit: boolean = (os.arch() === 'x64');

export const Id = "cerebus.atasm-altirra-bridge";
export const Path: string = vscode.extensions.getExtension(Id)!.extensionPath;
export const Name: string = vscode.extensions.getExtension(Id)!.packageJSON.name;
export const Publisher: string = vscode.extensions.getExtension(Id)!.packageJSON.publisher;
export const Version: string = vscode.extensions.getExtension(Id)!.packageJSON.version;
export const DisplayName: string = vscode.extensions.getExtension(Id)!.packageJSON.displayName;
export const ShortName: string = vscode.extensions.getExtension(Id)!.packageJSON.shortName;
export const Description: string = vscode.extensions.getExtension(Id)!.packageJSON.description;
export const PreferencesSettingsExtensionPath: string = `${(IsMacOS ? "Code" : "File")} -> Preferences -> Settings -> Extensions -> ${DisplayName}`;
export const ChangeLogUri: vscode.Uri = vscode.Uri.parse(`https://marketplace.visualstudio.com/items/${Id}/changelog`);

export const AtasmBuildFilename: string = "atasm-build.json";
export const SymbolExplorerFilename: string = "asm-symbols.json";

export const CompilerOutputChannel: vscode.OutputChannel = vscode.window.createOutputChannel("Atasm Build");

export const RunAssembler: AssemblerRunnerBase[] = [
	new AtasmAssemblerRunner(),
	new MadsAssemblerRunner(),
];

export const Emulator: EmulatorRunner = new EmulatorRunner();
export var WorkspaceFolder: string = "";

export var SymbolExplorer: AsmSymbolProvider;

export interface AtasmConfigurationDefinition {
	input: string | undefined;
	includes: string[] | undefined;
	outputFolder: string | undefined;
	params: string | undefined;
	symbols: string[] | undefined;
	withDebug: boolean;
}

let buildConfig: AtasmConfigurationDefinition | undefined = undefined;

export function ClearBuildConfig() {
	buildConfig = undefined;
}

export function GetBuildConfig(): AtasmConfigurationDefinition | undefined {
	return buildConfig;
}

export async function EnsureBuildConfigIsLoaded(): Promise<boolean> {
	if (buildConfig) {
		return true;
	}
	return await LoadBuildConfigAsync();
}

export function SetupSymbolExplorer() {
	const rootPath = (vscode.workspace.workspaceFolders && (vscode.workspace.workspaceFolders.length > 0)) ? vscode.workspace.workspaceFolders[0].uri.fsPath : undefined;
	const asmSymbolsProvider = new AsmSymbolProvider(rootPath);
	SymbolExplorer = asmSymbolsProvider;

	vscode.window.registerTreeDataProvider('asmSymbolExplorer', asmSymbolsProvider);
	vscode.commands.registerCommand('asmSymbolExplorer.refreshEntry', () => asmSymbolsProvider.refresh());
	vscode.commands.registerCommand('extension.openSourceAtLine', async info => {
		const uri = vscode.Uri.joinPath(vscode.Uri.file(info.loc), info.file);

		vscode.workspace.openTextDocument(uri).then(doc => {
			vscode.window.showTextDocument(doc, { preview: false }).then(editor => {
				const line: number = parseInt(info.ln, 10)-1;
				editor.selection = new vscode.Selection(new vscode.Position(line, 0), new vscode.Position(line, 0));
				editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.Default);
			});
		});
	});
}

export async function LoadBuildConfigAsync(retrying: boolean = false): Promise<boolean> {
	if (!vscode.workspace.workspaceFolders) {
		if (!retrying) {
			vscode.window.showInformationMessage('No folder or workspace opened');
		}
		return false;
	}
	const folder = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
	if (folder) {
		WorkspaceFolder = folder;
		let readFileData:string = '{"outputFolder": "out","withDebug": true}';

		let configuration = GetConfiguration();
		let forceConfigFile = configuration.get<boolean>(`application.configuration.forceUseOfBuildConfigFile`);

		if (forceConfigFile) {
			try {
				const readFile = util.promisify(fs.readFile);
				readFileData = await readFile(path.join(folder || "", AtasmBuildFilename), "utf-8");
			}
			catch (err) {
				buildConfig = undefined;
				if (!await CreateAtasmBuildJsonAsync()) {
					vscode.window.showInformationMessage('Failed to created the default build configuration file!');
					return false;
				}
				if (!retrying) {
					return await LoadBuildConfigAsync(true);
				}
				return false;
			}
		}

		try {
			buildConfig = JSON.parse(readFileData);
			return true;
		}
		catch (err) {
			buildConfig = undefined;
			vscode.window.showInformationMessage('Unable to parse the config file. JSON syntax error!');
			return false;
		}
	}
	else {
		buildConfig = undefined;
		vscode.window.showInformationMessage('Unable to open the folder for building.');
		return false;
	}
}

export async function BuildGameAsync(fileUri: vscode.Uri, assemblerId?: string): Promise<boolean> {
	if (!await SaveFilesAndContinueAsync(fileUri)) {
		vscode.window.showErrorMessage("Unable to save files");
		return false;
	}
	if (!await EnsureBuildConfigIsLoaded()) {
		vscode.window.showErrorMessage("Build configuration not setup");
	}

	return await SelectAssembler(assemblerId).BuildGameAsync();
}

export async function BuildGameAndRunAsync(fileUri: vscode.Uri, assemblerId?: string): Promise<boolean> {
	if (!await BuildGameAsync(fileUri, assemblerId)) {
		return false;
	}
	await Emulator.RunGameAsync(SelectAssembler(assemblerId).OutputFileName);
	return true;
}

export async function BuildAndDebugAsync(fileUri: vscode.Uri, assemblerId?: string): Promise<boolean> {
	let breakpoints = vscode.debug.breakpoints;

	if (!await BuildGameAsync(fileUri, assemblerId)) {
		return false;
	}

	await SaveBreakpoints(assemblerId);
	await Emulator.RunDebuggerAsync(SelectAssembler(assemblerId).OutputFileName);
	return true;
}

export async function ResetBuildAsync() {
	SelectAssembler().ResetBuild();
}

export async function SaveBreakpoints(assemblerId?: string): Promise<boolean> {
	const assembler = SelectAssembler(assemblerId);
	var folder = assembler.OutputBreakpoints;
	if (!folder || folder.length === 0) {
		return false;
	}
	var breakLines = "";
	var lastSrcFile = "";
	var fixedSrcFile = "";
	var breakpointLines = "";
	var atLines: number[] = [];
	var numFiles = 0;
	var numBreakpoints = 0;

	WriteToCompilerTerminal("Processing breakpoints...");

	let breakpoints = vscode.debug.breakpoints;
	breakpoints.forEach(element => {
		if (element !== undefined || element !== null) {
			let point = <vscode.SourceBreakpoint>element;
			if (point.enabled && point.location.uri.scheme === "file") {
				var file = path.relative(WorkspaceFolder, point.location.uri.fsPath);
				if (lastSrcFile !== file.toLowerCase()) {
					++numFiles;
					if (atLines.length > 0) {
						var sorted: number[] = atLines.sort((n1, n2) => n1 - n2);
						sorted.forEach(x => breakLines += `${x}` + os.EOL);
					}
					lastSrcFile = file.toLowerCase();
					fixedSrcFile = lastSrcFile.replace(/\\/gi, '/');
					breakLines += `Source: ${point.location.uri.fsPath}` + os.EOL;
					atLines = [];
				}
				++numBreakpoints;
				atLines.push(point.location.range.start.line + 1);
				if (point.condition) {
					breakpointLines += `bx "${point.condition}"` + os.EOL;
				}
				else {
					breakpointLines += `bp "\`${point.location.uri.fsPath}:${point.location.range.start.line + 1}\`"` + os.EOL;
				}
			}
		}
	});
	if (atLines.length > 0) {
		var sorted: number[] = atLines.sort((n1, n2) => n1 - n2);
		sorted.forEach(x => breakLines += `${x}` + os.EOL);
	}

	if (breakLines.length > 0) {
		let writeData = Buffer.from(breakLines, 'utf8');
		await vscode.workspace.fs.writeFile(vscode.Uri.file(assembler.OutputBreakpoints), writeData);

		var atdbgLines = ".sourcemode on" + os.EOL;
		atdbgLines += ".echo" + os.EOL;
		atdbgLines += '.echo "Loading executable..."' + os.EOL;
		atdbgLines += ".echo" + os.EOL;
		atdbgLines += "bc *" + os.EOL;
		atdbgLines += '.onexerun .echo "Launching executable..."' + os.EOL;
		atdbgLines += breakpointLines;
		atdbgLines += `.echo ${numBreakpoints} breakpoints from ${numFiles} files have been set` + os.EOL;

		writeData = Buffer.from(atdbgLines, 'utf8');
		await vscode.workspace.fs.writeFile(vscode.Uri.file(assembler.OutputDebugCmds), writeData);

		WriteToCompilerTerminal(`${numBreakpoints} breakpoints from ${numFiles} files have been recorded.`);
	}

	return true;
}

export async function CreateAtasmBuildJsonAsync(): Promise<boolean> {
	if (!vscode.workspace.workspaceFolders) {
		vscode.window.showInformationMessage('No folder or workspace opened');
		return false;
	}
	const folderUri = vscode.workspace.workspaceFolders?.[0].uri;
	if (folderUri) {
		let filename = path.join(folderUri.fsPath, AtasmBuildFilename);
		let uri = vscode.Uri.file(filename);

		try {
			await vscode.workspace.fs.stat(uri);
			vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.Active });
		} catch {
			let configSrc = [
				"comment", "Altirra configuration file.",
				"\n",
				"_1", "Which asm file is to be compiled?",
				"input", "theapp.asm",
				"\n",
				"_2", "Array of folders that will be searched when files are .include(d)",
				"includes", "[]",
				"\n",
				"_3", "Which folder will all the output files be written to. 'out' by default. Always in the workspace!",
				"outputFolder", "out",
				"\n",
				"_4", "Additional Atasm parameters:-v -s -u -r -fvalue",
				"params", "",
				"\n",
				"_5", "List of symbols to be set via the parameter list",
				"symbols", "[]",
				"\n",
				"_6", "If debug is enabled then symbol table and listings are generated for Altirra debugging",
				"withDebug", true
			];
			let config = "{" + os.EOL;
			for (var i = 0; i < configSrc.length;) {
				if (configSrc[i] === "\n") {
					config += os.EOL;
					++i;
				} else {
					config += `\t"${configSrc[i]}": `;
					++i;
					if (configSrc[i] === null) {
						config += "null";
					} else if (configSrc[i] === "[]") {
						config += "[]";
					} else if (typeof configSrc[i] === 'boolean') {
						config += configSrc[i];
					} else {
						config += `"${configSrc[i]}"`;
					}
					++i;
					if (i < configSrc.length) {
						config += "," + os.EOL;
					}
				}
			}
			config += os.EOL + "}" + os.EOL;

			const writeData = Buffer.from(config, 'utf8');
			const fileUri = folderUri.with({ path: path.join(folderUri.fsPath, AtasmBuildFilename) });
			await vscode.workspace.fs.writeFile(fileUri, writeData);
			vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.Active });
		}

		return true;
	}
	return false;
}

export function WriteToCompilerTerminal(message: string, writeToLog: boolean = false): void {
	CompilerOutputChannel.appendLine(message);
	if (writeToLog) { console.log(`debugger:${message}`); }
}

export function ShowWarningPopup(message: string): void {
	vscode.window.showWarningMessage(message);
}

export function ShowInformationPopup(message: string): void {
	vscode.window.showInformationMessage(message);
}

export function ShowErrorPopup(message: string): void {
	vscode.window.showErrorMessage(message);
}

export function GetConfiguration(): vscode.WorkspaceConfiguration {
	return vscode.workspace.getConfiguration(Name, null);
}

export async function ShowStartupMessagesAsync(): Promise<void> {
	let configuration = GetConfiguration();
	let showNewVersionMessage = configuration.get<boolean>(`application.configuration.showNewVersionMessage`);
	let latestVersion = configuration.get<string>(`application.configuration.latestVersion`);

	if (!showNewVersionMessage || latestVersion === Version) { return; }

	configuration.update(`application.configuration.latestVersion`, Version, vscode.ConfigurationTarget.Global);

	let latestChanges = "Learn more about the latest changes";
	let dontShowMeThisMessage = "Don't show me this message again";

	await vscode.window.showInformationMessage(`Welcome to the new version of ${DisplayName}`,
		latestChanges, dontShowMeThisMessage)
		.then(selection => {
			if (selection === undefined) {
			}
			else if (selection === latestChanges) {
				vscode.env.openExternal(ChangeLogUri);
			}
			else if (selection = dontShowMeThisMessage) {
				configuration.update(`application.configuration.showNewVersionMessage`, false, vscode.ConfigurationTarget.Global);
			}
		});
}

export function delay(ms: number) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

export async function SaveFilesAndContinueAsync(fileUri: vscode.Uri | undefined): Promise<boolean> {
	let configuration = GetConfiguration();
	let result: boolean = true;

	if (configuration.get<boolean>(`editor.saveAllFilesBeforeBuild`)) {
		result = await vscode.workspace.saveAll();
	} else if (configuration.get<boolean>(`editor.saveFileBeforeBuild`)) {
		if (fileUri) {
			let document = await filesystem.GetDocumentAsync(fileUri);
			if (document && document.uri.scheme === "file") {
				result = await document.save();
			}
		}
	}
	return result;
}

export async function getAssemblerCommandLine4Task(filename: string | undefined, assemblerId?: string): Promise<string> {
	return await SelectAssembler(assemblerId).GetAssemblerCommandLine4Task(filename);
}

export function SelectAssembler(whichAssembler?: string): AssemblerRunnerBase {
	let configuration = GetConfiguration();
	let command = whichAssembler ?? configuration.get<string>('assembler.whichAssembler', 'ATasm');

	var asmIdx = RunAssembler.findIndex(asm => asm.Id === command);
	if (asmIdx < 0) {
		asmIdx = 0;
	}
	return RunAssembler[asmIdx];
}
