/*
mp3编码器，需带上mp3-engine.js引擎使用
https://github.com/xiangyuecn/Recorder

当然最佳推荐使用mp3、wav格式，代码也是优先照顾这两种格式
浏览器支持情况
https://developer.mozilla.org/en-US/docs/Web/HTML/Supported_media_formats
*/
import Recorder from "../recorder-core";
import lamejs from "./mp3-engine";

Recorder.prototype.enc_mp3 = {
  stable: true,
  testmsg:
    "采样率范围48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000"
};

//*******标准UI线程转码支持函数************

Recorder.prototype.mp3 = function(res, True, False) {
  var This = this,
    set = This.set,
    size = res.length;

  //优先采用worker编码，太低版本下面用老方法提供兼容
  var ctx = This.mp3_start(set);
  if (ctx) {
    This.mp3_encode(ctx, res);
    This.mp3_complete(ctx, True, False, 1);
    return;
  }

  //https://github.com/wangpengfei15975/recorder.js
  //https://github.com/zhuker/lamejs bug:采样率必须和源一致，不然8k时没有声音，有问题fix：https://github.com/zhuker/lamejs/pull/11
  var mp3 = new lamejs.Mp3Encoder(1, set.sampleRate, set.bitRate);

  var blockSize = 57600;
  var data = [];

  var idx = 0,
    mp3Size = 0;
  var run = function() {
    if (idx < size) {
      var buf = mp3.encodeBuffer(res.subarray(idx, idx + blockSize));
      if (buf.length > 0) {
        mp3Size += buf.buffer.byteLength;
        data.push(buf.buffer);
      }
      idx += blockSize;
      setTimeout(run); //尽量避免卡ui
    } else {
      var buf = mp3.flush();
      if (buf.length > 0) {
        mp3Size += buf.buffer.byteLength;
        data.push(buf.buffer);
      }

      //去掉开头的标记信息帧
      var meta = mp3TrimFix.fn(data, mp3Size, size, set.sampleRate);
      mp3TrimFixSetMeta(meta, set);

      True(new Blob(data, { type: "audio/mp3" }));
    }
  };
  run();
};

//********边录边转码(Worker)支持函数，如果提供就代表可能支持，否则只支持标准转码*********

//全局共享一个Worker，后台串行执行。如果每次都开一个新的，编码速度可能会慢很多，可能是浏览器运行缓存的因素，并且可能瞬间产生多个并行操作占用大量cpu
var mp3Worker;
Recorder.BindDestroy("mp3Worker", function() {
  console.log("mp3Worker Destroy");
  mp3Worker && mp3Worker.terminate();
  mp3Worker = null;
});

var openList = { id: 0 };
Recorder.prototype.mp3_start = function(set) {
  //如果返回null代表不支持
  var worker = mp3Worker;
  try {
    var onmsg = function(e) {
      var ed = e.data;
      var cur = wk_ctxs[ed.id];
      if (ed.action == "init") {
        wk_ctxs[ed.id] = {
          sampleRate: ed.sampleRate,
          bitRate: ed.bitRate,

          mp3Size: 0,
          pcmSize: 0,
          encArr: [],
          encObj: new wk_lame.Mp3Encoder(1, ed.sampleRate, ed.bitRate)
        };
      } else if (!cur) {
        return;
      }

      switch (ed.action) {
        case "stop":
          cur.encObj = null;
          delete wk_ctxs[ed.id];
          break;
        case "encode":
          cur.pcmSize += ed.pcm.length;
          var buf = cur.encObj.encodeBuffer(ed.pcm);
          if (buf.length > 0) {
            cur.mp3Size += buf.buffer.byteLength;
            cur.encArr.push(buf.buffer);
          }
          break;
        case "complete":
          var buf = cur.encObj.flush();
          if (buf.length > 0) {
            cur.mp3Size += buf.buffer.byteLength;
            cur.encArr.push(buf.buffer);
          }

          //去掉开头的标记信息帧
          var meta = wk_mp3TrimFix.fn(
            cur.encArr,
            cur.mp3Size,
            cur.pcmSize,
            cur.sampleRate
          );

          self.postMessage({
            action: ed.action,
            id: ed.id,
            blob: new Blob(cur.encArr, { type: "audio/mp3" }),
            meta: meta
          });
          break;
      }
    };
    if (!worker) {
      //创建一个新Worker
      var jsCode = ");wk_lame();var wk_ctxs={};self.onmessage=" + onmsg;
      jsCode +=
        ";var wk_mp3TrimFix={rm:" +
        mp3TrimFix.rm +
        ",fn:" +
        mp3TrimFix.fn +
        "}";

      var lamejsCode = lamejs.toString();
      var url = (window.URL || webkitURL).createObjectURL(
        new Blob(["var wk_lame=(", lamejsCode, jsCode], {
          type: "text/javascript"
        })
      );

      worker = new Worker(url);
      (window.URL || webkitURL).revokeObjectURL(url); //必须要释放，不然每次调用内存都明显泄露内存

      worker.onmessage = function(e) {
        var ctx = openList[e.data.id];
        if (ctx) {
          ctx.call && ctx.call(e.data);
          ctx.call = null;
        }
      };
    }

    var ctx = { worker: worker, set: set };
    ctx.id = ++openList.id;
    openList[ctx.id] = ctx;

    worker.postMessage({
      action: "init",
      id: ctx.id,
      sampleRate: set.sampleRate,
      bitRate: set.bitRate,

      x: new Int16Array(5) //低版本浏览器不支持序列化TypedArray
    });

    mp3Worker = worker;
    return ctx;
  } catch (e) {
    //出错了就不要提供了
    worker && worker.terminate();

    console.error(e);
    return null;
  }
};
Recorder.prototype.mp3_stop = function(startCtx) {
  if (startCtx && startCtx.worker) {
    startCtx.worker.postMessage({
      action: "stop",
      id: startCtx.id
    });
    startCtx.worker = null;
    delete openList[startCtx.id];

    //疑似泄露检测 排除id
    var opens = -1;
    for (var k in openList) {
      opens++;
    }
    if (opens) {
      console.warn("mp3 worker剩" + opens + "个在串行等待");
    }
  }
};
Recorder.prototype.mp3_encode = function(startCtx, pcm) {
  if (startCtx && startCtx.worker) {
    startCtx.worker.postMessage({
      action: "encode",
      id: startCtx.id,
      pcm: pcm
    });
  }
};
Recorder.prototype.mp3_complete = function(startCtx, True, False, autoStop) {
  var This = this;
  if (startCtx && startCtx.worker) {
    startCtx.call = function(data) {
      mp3TrimFixSetMeta(data.meta, startCtx.set);
      True(data.blob);

      if (autoStop) {
        This.mp3_stop(startCtx);
      }
    };
    startCtx.worker.postMessage({
      action: "complete",
      id: startCtx.id
    });
  } else {
    False("mp3编码器未打开");
  }
};

//*******辅助函数************

/*读取lamejs编码出来的mp3信息，只能读特定格式，如果读取失败返回null
mp3Buffers=[ArrayBuffer,...]
length=mp3Buffers的数据二进制总长度
*/
Recorder.mp3ReadMeta = function(mp3Buffers, length) {
  var u8arr0 = new Uint8Array(mp3Buffers[0] || []);
  if (u8arr0.length < 4) {
    return null;
  }
  var byteAt = function(idx, u8) {
    return ("0000000" + ((u8 || u8arr0)[idx] || 0).toString(2)).substr(-8);
  };
  var b2 = byteAt(0) + byteAt(1);
  var b4 = byteAt(2) + byteAt(3);

  if (!/^1{11}/.test(b2)) {
    //未发现帧同步
    return null;
  }
  var version = { "00": 2.5, "10": 2, "11": 1 }[b2.substr(11, 2)];
  var layer = { "01": 3 }[b2.substr(13, 2)]; //仅支持Layer3
  var sampleRate = {
    //lamejs -> Tables.samplerate_table
    "1": [44100, 48000, 32000],
    "2": [22050, 24000, 16000],
    "2.5": [11025, 12000, 8000]
  }[version];
  sampleRate && (sampleRate = sampleRate[parseInt(b4.substr(4, 2), 2)]);
  var bitRate = [
    //lamejs -> Tables.bitrate_table
    [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160], //MPEG 2 2.5
    [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320] //MPEG 1
  ][version == 1 ? 1 : 0][parseInt(b4.substr(0, 4), 2)];

  if (!version || !layer || !bitRate || !sampleRate) {
    return null;
  }

  var duration = Math.round((length * 8) / bitRate);
  var frame = layer == 1 ? 384 : layer == 2 ? 1152 : version == 1 ? 1152 : 576;
  var frameDurationFloat = (frame / sampleRate) * 1000;
  var frameSize = Math.floor(((frame * bitRate) / 8 / sampleRate) * 1000);

  //检测是否存在Layer3帧填充1字节，如果有一处padding，lamejs的后续全部为填充
  var hasPadding = 0,
    seek = 0;
  for (var i = 0; i < mp3Buffers.length; i++) {
    //寻找第二帧
    var buf = mp3Buffers[i];
    seek += buf.byteLength;
    if (seek >= frameSize + 3) {
      var buf8 = new Uint8Array(buf);
      var idx = buf.byteLength - (seek - (frameSize + 3) + 1);
      var ib4 = byteAt(idx, buf8);
      hasPadding = ib4.charAt(6) == "1";
      break;
    }
  }
  if (hasPadding) {
    frameSize++;
  }

  return {
    version: version, //1 2 2.5 -> MPEG1 MPEG2 MPEG2.5
    layer: layer, //3 -> Layer3
    sampleRate: sampleRate, //采样率 hz
    bitRate: bitRate, //比特率 kbps

    duration: duration, //音频时长 ms
    size: length, //总长度 byte
    hasPadding: hasPadding, //每帧是否存在1字节填充，首帧永远没有
    frameSize: frameSize, //每帧长度，含可能存在的1字节padding byte
    frameDurationFloat: frameDurationFloat //每帧时长，含小数 ms
  };
};

//去掉lamejs开头的标记信息帧，免得mp3解码出来的时长比pcm的长太多
var mp3TrimFix = {
  //minfiy keep name
  rm: Recorder.mp3ReadMeta,
  fn: function(mp3Buffers, length, pcmLength, pcmSampleRate) {
    var meta = this.rm(mp3Buffers, length);
    if (!meta) {
      return { err: "mp3非预定格式" };
    }
    var pcmDuration = Math.round((pcmLength / pcmSampleRate) * 1000);

    //开头多出这么多帧，移除掉
    var num = Math.floor(
      (meta.duration - pcmDuration) / meta.frameDurationFloat
    );
    if (num > 0) {
      var size = num * meta.frameSize - (meta.hasPadding ? 1 : 0);
      length -= size;
      var arr0 = 0,
        arrs = [];
      for (var i = 0; i < mp3Buffers.length; i++) {
        var arr = mp3Buffers[i];
        if (size <= 0) {
          break;
        }
        if (size >= arr.byteLength) {
          size -= arr.byteLength;
          arrs.push(arr);
          mp3Buffers.splice(i, 1);
          i--;
        } else {
          mp3Buffers[i] = arr.slice(size);
          arr0 = arr;
          size = 0;
        }
      }
      var checkMeta = this.rm(mp3Buffers, length);
      if (!checkMeta) {
        //还原变更，应该不太可能会出现
        arr0 && (mp3Buffers[0] = arr0);
        for (var i = 0; i < arrs.length; i++) {
          mp3Buffers.splice(i, 0, arrs[i]);
        }
        meta.err = "fix后数据错误，已还原，错误原因不明";
      }

      var fix = (meta.trimFix = {});
      fix.remove = num;
      fix.removeDuration = Math.round(num * meta.frameDurationFloat);
      fix.duration = Math.round((length * 8) / meta.bitRate);
    }
    return meta;
  }
};
var mp3TrimFixSetMeta = function(meta, set) {
  var tag = "MP3信息 ";
  if (
    (meta.sampleRate && meta.sampleRate != set.sampleRate) ||
    (meta.bitRate && meta.bitRate != set.bitRate)
  ) {
    console.warn(
      tag +
        "和设置的不匹配set:" +
        set.bitRate +
        "kbps " +
        set.sampleRate +
        "hz，已更新set:" +
        meta.bitRate +
        "kbps " +
        meta.sampleRate +
        "hz",
      set
    );
    set.sampleRate = meta.sampleRate;
    set.bitRate = meta.bitRate;
  }

  var trimFix = meta.trimFix;
  if (trimFix) {
    tag +=
      "Fix移除" +
      trimFix.remove +
      "帧" +
      trimFix.removeDuration +
      "ms -> " +
      trimFix.duration +
      "ms";
    if (trimFix.remove > 2) {
      meta.err = (meta.err ? meta.err + ", " : "") + "移除帧数过多";
    }
  } else {
    tag += (meta.duration || "-") + "ms";
  }

  if (meta.err) {
    console.error(tag, meta.err, meta);
  } else {
    console.log(tag, meta);
  }
};

export default Recorder;
