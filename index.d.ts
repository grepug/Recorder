declare module "@grepug/recorder" {
  const Recorder: (opts: {
    type: "mp3";
    sampleRate: number;
    bitRate: number;
    onProcess: any;
  }) => {
    open: (
      success: () => void,
      fail: (msg: string, isUserNotAllow: boolean) => void
    ) => void;
    start: () => void;
    stop: (
      cb: (blob: Blob, duration: number) => void,
      fail?: (msg: any) => void
    ) => void;
    close: () => void;
  };

  export = Recorder;
}
