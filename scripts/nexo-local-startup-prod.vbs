' Script de inicializacao silenciosa do NEXO Local em modo prod-local
' Executado ao ligar o computador. Sobe emuladores + build + next start.

Dim shell
Set shell = CreateObject("WScript.Shell")

Dim scriptDir
scriptDir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)

Dim cmd
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & scriptDir & "\nexo-local-startup.ps1"" -NoSeed -ProdLocal"

shell.Run cmd, 7, False
