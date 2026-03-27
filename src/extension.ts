import * as vscode from 'vscode';
import * as application from './application';
import { WelcomePage } from './pages/welcome';
import './statusbar';

import { MemoryViewProvider } from './views/MemoryViewProvider';

import * as path from 'path';
import * as fs from 'fs';
import * as util from 'util';

let taskProvider: vscode.Disposable | undefined;
let atasmConfigWatcher: vscode.FileSystemWatcher | undefined;
let symbolExplorerConfigWatcher: vscode.FileSystemWatcher | undefined;
let memoryViewProvider: MemoryViewProvider | undefined;

export async function activate(context: vscode.ExtensionContext) {
	let welcomePage = new WelcomePage();

	const openWelcomePage = vscode.commands.registerCommand('extension.openWelcomePage', () => {
		welcomePage.openPage(context);
	});

	const buildGame = vscode.commands.registerCommand('extension.buildGame', async (fileUri: vscode.Uri) => {
		await application.BuildGameAsync(fileUri);
	});
	const buildGameAndRun = vscode.commands.registerCommand('extension.buildGameAndRun', async (fileUri: vscode.Uri) => {
		await application.BuildGameAndRunAsync(fileUri);
	});
	const buildAndDebug = vscode.commands.registerCommand('extension.buildAndDebug', async (fileUri: vscode.Uri) => {
		await application.BuildAndDebugAsync(fileUri);
	});

	const buildGameMads = vscode.commands.registerCommand('extension.buildGameMads', async (fileUri: vscode.Uri) => {
		await application.BuildGameAsync(fileUri, "Mads");
	});
	const buildGameAndRunMads = vscode.commands.registerCommand('extension.buildGameAndRunMads', async (fileUri: vscode.Uri) => {
		await application.BuildGameAndRunAsync(fileUri, "Mads");
	});
	const buildAndDebugMads = vscode.commands.registerCommand('extension.buildAndDebugMads', async (fileUri: vscode.Uri) => {
		await application.BuildAndDebugAsync(fileUri, "Mads");
	});

	const buildGameAtasm = vscode.commands.registerCommand('extension.buildGameAtasm', async (fileUri: vscode.Uri) => {
		await application.BuildGameAsync(fileUri, "ATasm");
	});
	const buildGameAndRunAtasm = vscode.commands.registerCommand('extension.buildGameAndRunAtasm', async (fileUri: vscode.Uri) => {
		await application.BuildGameAndRunAsync(fileUri, "ATasm");
	});
	const buildAndDebugAtasm = vscode.commands.registerCommand('extension.buildAndDebugAtasm', async (fileUri: vscode.Uri) => {
		await application.BuildAndDebugAsync(fileUri, "ATasm");
	});

	const createAtasmBuildJson = vscode.commands.registerCommand('extension.createAtasmBuildJson', async () => {
		await application.CreateAtasmBuildJsonAsync();
	});
	const resetBuild = vscode.commands.registerCommand('extension.resetBuild', async () => {
		await application.ResetBuildAsync();
	});

	const folder = vscode.workspace.workspaceFolders?.[0];
	if (folder) {
		let buildConfigPromise: Thenable<vscode.Task[]> | undefined = undefined;

		vscode.window.onDidChangeActiveTextEditor(() => application.ClearBuildConfig());

		atasmConfigWatcher = vscode.workspace.createFileSystemWatcher(path.join(folder.uri.fsPath, application.AtasmBuildFilename));
		atasmConfigWatcher.onDidChange(() => application.ClearBuildConfig());
		atasmConfigWatcher.onDidCreate(() => application.ClearBuildConfig());
		atasmConfigWatcher.onDidDelete(() => application.ClearBuildConfig());

		symbolExplorerConfigWatcher = vscode.workspace.createFileSystemWatcher(path.join(folder.uri.fsPath, application.SymbolExplorerFilename));
		symbolExplorerConfigWatcher.onDidChange(() => application.SymbolExplorer.refresh());
		symbolExplorerConfigWatcher.onDidCreate(() => application.SymbolExplorer.refresh());
		symbolExplorerConfigWatcher.onDidDelete(() => application.SymbolExplorer.refresh());
		
		taskProvider = vscode.tasks.registerTaskProvider('atasm', {
			provideTasks: () => {
				buildConfigPromise = getAssemblerTasks();
				return buildConfigPromise;
			},
			resolveTask(_task: vscode.Task): vscode.Task | undefined {
				return undefined;
			}
		});
	}

	context.subscriptions.push(openWelcomePage);
	context.subscriptions.push(buildGame);
	context.subscriptions.push(buildGameAndRun);
	context.subscriptions.push(buildAndDebug);
	context.subscriptions.push(buildGameMads);
	context.subscriptions.push(buildGameAndRunMads);
	context.subscriptions.push(buildAndDebugMads);
	context.subscriptions.push(buildGameAtasm);
	context.subscriptions.push(buildGameAndRunAtasm);
	context.subscriptions.push(buildAndDebugAtasm);
	context.subscriptions.push(resetBuild);

	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(configChanged));

	memoryViewProvider = new MemoryViewProvider(context.extensionUri);
	memoryViewProvider.extContext = context;
	memoryViewProvider.extOutput = application.CompilerOutputChannel;
	context.subscriptions.push(vscode.window.registerWebviewViewProvider(MemoryViewProvider.viewType, 	memoryViewProvider));

	await application.ShowStartupMessagesAsync();
	await application.SelectAssembler().FixExecPermissions();
	application.SetupSymbolExplorer();
}

export function deactivate() { }

export function forwardBuildData(data:string)
{
	if (memoryViewProvider)
	{
		memoryViewProvider.setBuildDataCache("build", data);
	}
}

interface AssemblerTaskDefinition extends vscode.TaskDefinition {
	task: string;
}

async function getAssemblerTasks(): Promise<vscode.Task[]> {
	let tasks: vscode.Task[] = [];
	let buildConfig: application.AtasmConfigurationDefinition | undefined = undefined;
	let editor = vscode.window.activeTextEditor;

	if (editor && editor.document && editor.document.fileName && (editor.document.languageId === "atasm" || editor.document.languageId === "json" )) {
		let input: string = editor.document.fileName;
		const folder = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
		if (folder) {
			try {
				const readFile = util.promisify(fs.readFile);
				const readFileData = await readFile(path.join(folder || "", application.AtasmBuildFilename), "utf-8");
				buildConfig = JSON.parse(readFileData);

				if (buildConfig?.input && buildConfig?.input.trim().length > 0) {
					let commandLine = await application.getAssemblerCommandLine4Task(undefined);
					if (commandLine.length) {
						let buildTaskDef: AssemblerTaskDefinition = { type: "atasm", task: "From JSON" };
						let buildTask = new vscode.Task(buildTaskDef, vscode.TaskScope.Workspace, "Assemble from atasm-build settings", "atasm",
							new vscode.ShellExecution(commandLine),
							["$atasm"]);
						buildTask.group = vscode.TaskGroup.Build;
						tasks.push(buildTask);
					}
				}
			}
			catch (err) {
			}
		}

		if (editor.document.languageId === "atasm") {
			let commandLine = await application.getAssemblerCommandLine4Task(input);
			if (commandLine.length) {
				let buildTaskDef: AssemblerTaskDefinition = { type: "atasm", task: "Direct" };
				let buildTask = new vscode.Task(buildTaskDef, vscode.TaskScope.Workspace, "Assemble the current file only", "atasm",
					new vscode.ShellExecution(commandLine),
					["$atasm"]);
				buildTask.group = vscode.TaskGroup.Build;
				tasks.push(buildTask);
			}
		}
	}

	return tasks;
}

function configChanged(e:vscode.ConfigurationChangeEvent) {
	let affected = e.affectsConfiguration("atasm");

	if (memoryViewProvider) {
		memoryViewProvider.viewInit();	
	}
}
