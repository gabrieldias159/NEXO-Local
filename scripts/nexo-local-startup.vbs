' Script de inicializacao silenciosa do NEXO Local
' Executado ao ligar o computador (via Startup folder ou Task Scheduler).
' Roda o PowerShell startup script em janela minimizada.

Dim shell
Set shell = CreateObject("WScript.Shell")

' Obtem o diretorio onde este script esta
Dim scriptDir
scriptDir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)

' Sobe um nivel (de scripts/ para raiz do projeto)
Dim projectRoot
projectRoot = shell.ExpandEnvironmentStrings(scriptDir & "\..")

' Comando: PowerShell que executa o startup script
Dim cmd
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & scriptDir & "\nexo-local-startup.ps1"" -NoSeed"

' Executa em janela minimizada (window style 7 = minimizado, 0 = oculto)
shell.Run cmd, 7, False
