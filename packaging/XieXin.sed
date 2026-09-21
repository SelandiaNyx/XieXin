[Version]
Class=IEXPRESS
SEDVersion=3

[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=0
HideExtractAnimation=1
UseLongFileName=1
InsideCompressed=1
CAB_FixedSize=0
CAB_ResvCodeSigning=0
RebootMode=N
InstallPrompt=%InstallPrompt%
DisplayLicense=
FinishMessage=%FinishMessage%
TargetName=XieXin-Setup-0.1.0.exe
FriendlyName=%FriendlyName%
AppLaunched=install.cmd
PostInstallCmd=<None>
SourceFiles=SourceFiles

[Strings]
InstallPrompt=
FinishMessage=XieXin 安装完成。
FriendlyName=XieXin 安装程序
FILE0="XieXin.exe"
FILE1="install.cmd"
FILE2="WebView2Loader.dll"

[SourceFiles]
SourceFiles0=.

[SourceFiles0]
%FILE0%=
%FILE1%=
%FILE2%=