namespace Transversals.GuestAgent.Host;

public sealed record GuestHostPorts(
    IAgentInfo Info,
    IProcessRunner Process,
    IScreenCapture Screen,
    IInputSender Input,
    IWindowManager Windows);
