/*
录音
https://github.com/xiangyuecn/Recorder
*/

//兼容环境
var LM = "2019-11-7 21:47:48";
var NOOP = function() {};
//end 兼容环境 ****从以下开始copy源码*****

var Recorder = function(set) {
  return new initFn(set);
};
//是否已经打开了录音，所有工作都已经准备好了，就等接收音频数据了
Recorder.IsOpen = function() {
  var stream = Recorder.Stream;
  if (stream) {
    var tracks =
      (stream.getTracks && stream.getTracks()) || stream.audioTracks || [];
    var track = tracks[0];
    if (track) {
      var state = track.readyState;
      return state == "live" || state == track.LIVE;
    }
  }
  return false;
};
/*H5录音时的AudioContext缓冲大小。会影响H5录音时的onProcess调用速率，相对于AudioContext.sampleRate=48000时，4096接近12帧/s，调节此参数可生成比较流畅的回调动画。
	取值256, 512, 1024, 2048, 4096, 8192, or 16384
	注意，取值不能过低，2048开始不同浏览器可能回调速率跟不上造成音质问题。
	一般无需调整，调整后需要先close掉已打开的录音，再open时才会生效。
*/
Recorder.BufferSize = 4096;
//销毁已持有的所有全局资源，当要彻底移除Recorder时需要显式的调用此方法
Recorder.Destroy = function() {
  console.log("Recorder Destroy");
  for (var k in DestroyList) {
    DestroyList[k]();
  }
};
var DestroyList = {};
//登记一个需要销毁全局资源的处理方法
Recorder.BindDestroy = function(key, call) {
  DestroyList[key] = call;
};
//判断浏览器是否支持录音，随时可以调用。注意：仅仅是检测浏览器支持情况，不会判断和调起用户授权，不会判断是否支持特定格式录音。
Recorder.Support = function() {
  var AC = window.AudioContext;
  if (!AC) {
    AC = window.webkitAudioContext;
  }
  if (!AC) {
    return false;
  }
  var scope = navigator.mediaDevices || {};
  if (!scope.getUserMedia) {
    scope = navigator;
    scope.getUserMedia ||
      (scope.getUserMedia =
        scope.webkitGetUserMedia ||
        scope.mozGetUserMedia ||
        scope.msGetUserMedia);
  }
  if (!scope.getUserMedia) {
    return false;
  }

  Recorder.Scope = scope;
  if (!Recorder.Ctx || Recorder.Ctx.state == "closed") {
    //不能反复构造，低版本number of hardware contexts reached maximum (6)
    Recorder.Ctx = new AC();

    Recorder.BindDestroy("Ctx", function() {
      var ctx = Recorder.Ctx;
      ctx && ctx.close && ctx.close();
    });
  }
  return true;
};
/*初始化H5音频采集连接，因为Stream是全局的，Safari上断开后就无法再次进行连接使用，表现为静音，因此使用全部使用全局处理避免调用到disconnect；全局处理也有利于屏蔽底层细节，start时无需再调用底层接口，提升兼容、可靠性。*/
var Connect = function() {
  var ctx = Recorder.Ctx,
    stream = Recorder.Stream;
  var media = (stream._m = ctx.createMediaStreamSource(stream));
  var process = (stream._p = (
    ctx.createScriptProcessor || ctx.createJavaScriptNode
  ).call(ctx, Recorder.BufferSize, 1, 1)); //单声道，省的数据处理复杂

  media.connect(process);
  process.connect(ctx.destination);

  var calls = (stream._call = {});
  process.onaudioprocess = function(e) {
    for (var k0 in calls) {
      //has item
      var o = e.inputBuffer.getChannelData(0); //块是共享的，必须复制出来
      var size = o.length;

      var pcm = new Int16Array(size);
      var sum = 0;
      for (var j = 0; j < size; j++) {
        //floatTo16BitPCM
        var s = Math.max(-1, Math.min(1, o[j]));
        s = s < 0 ? s * 0x8000 : s * 0x7fff;
        pcm[j] = s;
        sum += Math.abs(s);
      }

      for (var k in calls) {
        calls[k](pcm, sum);
      }

      return;
    }
  };
};
var Disconnect = function() {
  var stream = Recorder.Stream;
  if (stream._m) {
    stream._m.disconnect();
    stream._p.disconnect();
    stream._p.onaudioprocess = stream._p = stream._m = null;
  }
};

/*对pcm数据的采样率进行转换
pcmDatas: [[Int16,...]] pcm片段列表
pcmSampleRate:48000 pcm数据的采样率
newSampleRate:16000 需要转换成的采样率，newSampleRate>=pcmSampleRate时不会进行任何处理，小于时会进行重新采样
prevChunkInfo:{} 可选，上次调用时的返回值，用于连续转换，本次调用将从上次结束位置开始进行处理。或可自行定义一个ChunkInfo从pcmDatas指定的位置开始进行转换
option:{ 可选，配置项
		frameSize:123456 帧大小，每帧的PCM Int16的数量，采样率转换后的pcm长度为frameSize的整数倍，用于连续转换。目前仅在mp3格式时才有用，frameSize取值为1152，这样编码出来的mp3时长和pcm的时长完全一致，否则会因为mp3最后一帧录音不够填满时添加填充数据导致mp3的时长变长。
		frameType:"" 帧类型，一般为rec.set.type，提供此参数时无需提供frameSize，会自动使用最佳的值给frameSize赋值，目前仅支持mp3=1152(MPEG1 Layer3的每帧采采样数)，其他类型=1。
			以上两个参数用于连续转换时使用，最多使用一个，不提供时不进行帧的特殊处理，提供时必须同时提供prevChunkInfo才有作用。最后一段数据处理时无需提供帧大小以便输出最后一丁点残留数据。
	}

返回ChunkInfo:{
	//可定义，从指定位置开始转换到结尾
	index:0 pcmDatas已处理到的索引
	offset:0.0 已处理到的index对应的pcm中的偏移的下一个位置
	
	//仅作为返回值
	frameNext:null||[Int16,...] 下一帧的部分数据，frameSize设置了的时候才可能会有
	sampleRate:16000 结果的采样率，<=newSampleRate
	data:[Int16,...] 转换后的PCM结果；如果是连续转换，并且pcmDatas中并没有新数据时，data的长度可能为0
}
*/
Recorder.SampleData = function(
  pcmDatas,
  pcmSampleRate,
  newSampleRate,
  prevChunkInfo,
  option
) {
  prevChunkInfo || (prevChunkInfo = {});
  var index = prevChunkInfo.index || 0;
  var offset = prevChunkInfo.offset || 0;

  var frameNext = prevChunkInfo.frameNext || [];
  option || (option = {});
  var frameSize = option.frameSize || 1;
  if (option.frameType) {
    frameSize = option.frameType == "mp3" ? 1152 : 1;
  }

  var size = 0;
  for (var i = index; i < pcmDatas.length; i++) {
    size += pcmDatas[i].length;
  }
  size = Math.max(0, size - Math.floor(offset));

  //采样 https://www.cnblogs.com/blqw/p/3782420.html
  var step = pcmSampleRate / newSampleRate;
  if (step > 1) {
    //新采样高于录音采样不处理，省去了插值处理，直接抽样
    size = Math.floor(size / step);
  } else {
    step = 1;
    newSampleRate = pcmSampleRate;
  }

  size += frameNext.length;
  var res = new Int16Array(size);
  var idx = 0;
  //添加上一次不够一帧的剩余数据
  for (var i = 0; i < frameNext.length; i++) {
    res[idx] = frameNext[i];
    idx++;
  }
  //处理数据
  for (var nl = pcmDatas.length; index < nl; index++) {
    var o = pcmDatas[index];
    var i = offset,
      il = o.length;
    while (i < il) {
      //res[idx]=o[Math.round(i)]; 直接简单抽样

      //https://www.cnblogs.com/xiaoqi/p/6993912.html
      //当前点=当前点+到后面一个点之间的增量，音质比直接简单抽样好些
      var before = Math.floor(i);
      var after = Math.ceil(i);
      var atPoint = i - before;
      res[idx] = o[before] + (o[after] - o[before]) * atPoint;

      idx++;
      i += step; //抽样
    }
    offset = i - il;
  }
  //帧处理
  frameNext = null;
  var frameNextSize = res.length % frameSize;
  if (frameNextSize > 0) {
    var u8Pos = (res.length - frameNextSize) * 2;
    frameNext = new Int16Array(res.buffer.slice(u8Pos));
    res = new Int16Array(res.buffer.slice(0, u8Pos));
  }

  return {
    index: index,
    offset: offset,

    frameNext: frameNext,
    sampleRate: newSampleRate,
    data: res
  };
};
var ID = 0;
function initFn(set) {
  this.id = ++ID;

  //如果开启了流量统计，这里将发送一个图片请求

  var o = {
    type: "mp3", //输出类型：mp3,wav，wav输出文件尺寸超大不推荐使用，但mp3编码支持会导致js文件超大，如果不需支持mp3可以使js文件大幅减小
    bitRate: 16, //比特率 wav:16或8位，MP3：8kbps 1k/s，8kbps 2k/s 录音文件很小

    sampleRate: 16000, //采样率，wav格式大小=sampleRate*时间；mp3此项对低比特率有影响，高比特率几乎无影响。
    //wav任意值，mp3取值范围：48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000
    //采样率参考https://www.cnblogs.com/devin87/p/mp3-recorder.html

    onProcess: NOOP //fn(buffers,powerLevel,bufferDuration,bufferSampleRate) buffers=[[Int16,...],...]：缓冲的PCM数据，为从开始录音到现在的所有pcm片段；powerLevel：当前缓冲的音量级别0-100，bufferDuration：已缓冲时长，bufferSampleRate：缓冲使用的采样率（当type支持边录边转码(Worker)时，此采样率和设置的采样率相同，否则不一定相同）

    //,disableEnvInFix:false 内部参数，禁用设备卡顿时音频输入丢失补偿功能
  };

  for (var k in set) {
    o[k] = set[k];
  }
  this.set = o;

  this._S = 9; //stop同步锁，stop可以阻止open过程中还未运行的start
}
//同步锁，控制对Stream的竞争；用于close时中断异步的open；一个对象open如果变化了都要阻止close，Stream的控制权交个新的对象
Recorder.Sync = { /*open*/ O: 9, /*close*/ C: 9 };

Recorder.prototype = initFn.prototype = {
  //打开录音资源True(),False(msg,isUserNotAllow)，需要调用close。注意：此方法是异步的；一般使用时打开，用完立即关闭；可重复调用，可用来测试是否能录音
  open: function(True, False) {
    var This = this;
    True = True || NOOP;
    False = False || NOOP;

    var ok = function() {
      True();

      This._SO = 0; //解除stop对open中的start调用的阻止
    };
    var codeFail = function(code, msg) {
      if (/Permission|Allow/i.test(code)) {
        False("用户拒绝了录音权限", true);
      } else if (window.isSecureContext === false) {
        False("无权录音(需https)");
      } else if (/Found/i.test(code)) {
        //可能是非安全环境导致的没有设备
        False(msg + "，无可用麦克风");
      } else {
        False(msg);
      }
    };

    //同步锁
    var Lock = Recorder.Sync;
    var lockOpen = ++Lock.O,
      lockClose = Lock.C;
    This._O = This._O_ = lockOpen; //记住当前的open，如果变化了要阻止close，这里假定了新对象已取代当前对象并且不再使用
    This._SO = This._S; //记住open过程中的stop，中途任何stop调用后都不能继续open中的start
    var lockFail = function() {
      //允许多次open，但不允许任何一次close，或者自身已经调用了关闭
      if (lockClose != Lock.C || !This._O) {
        var err = "open被取消";
        if (lockOpen == Lock.O) {
          //无新的open，已经调用了close进行取消，此处应让上次的close明确生效
          This.close();
        } else {
          err = "open被中断";
        }
        False(err);
        return true;
      }
    };

    //如果已打开就不要再打开了
    if (Recorder.IsOpen()) {
      ok();
      return;
    }
    if (!Recorder.Support()) {
      codeFail("", "此浏览器不支持录音");
      return;
    }

    //请求权限，如果从未授权，一般浏览器会弹出权限请求弹框
    var f1 = function(stream) {
      Recorder.Stream = stream;
      if (lockFail()) return;

      //https://github.com/xiangyuecn/Recorder/issues/14 获取到的track.readyState!="live"，刚刚回调时可能是正常的，但过一下可能就被关掉了，原因不明。延迟一下保证真异步。对正常浏览器不影响
      setTimeout(function() {
        if (lockFail()) return;

        if (Recorder.IsOpen()) {
          Connect();
          ok();
        } else {
          False("录音功能无效：无音频流");
        }
      }, 100);
    };
    var f2 = function(e) {
      var code = e.name || e.message || e.code + ":" + e;
      console.error(e);

      codeFail(code, "无法录音：" + code);
    };
    var pro = Recorder.Scope.getUserMedia({ audio: true }, f1, f2);
    if (pro && pro.then) {
      pro.then(f1)[True && "catch"](f2); //fix 关键字，保证catch压缩时保持字符串形式
    }
  },
  //关闭释放录音资源
  close: function(call) {
    call = call || NOOP;

    var This = this;
    This._stop();

    var Lock = Recorder.Sync;
    This._O = 0;
    if (This._O_ != Lock.O) {
      //唯一资源Stream的控制权已交给新对象，这里不能关闭。此处在每次都弹权限的浏览器内可能存在泄漏，新对象被拒绝权限可能不会调用close，忽略这种不处理
      console.warn("close被忽略");
      call();
      return;
    }
    Lock.C++; //获得控制权

    var stream = Recorder.Stream;
    if (stream) {
      Disconnect();

      var tracks =
        (stream.getTracks && stream.getTracks()) || stream.audioTracks || [];
      for (var i = 0; i < tracks.length; i++) {
        var track = tracks[i];
        track.stop && track.stop();
      }
      stream.stop && stream.stop();
    }

    Recorder.Stream = 0;
    call();
  },

  /*模拟一段录音数据，后面可以调用stop进行编码，需提供pcm数据[1,2,3...]，pcm的采样率*/
  mock: function(pcmData, pcmSampleRate) {
    var This = this;
    This._stop(); //清理掉已有的资源

    This.isMock = 1;
    This.buffers = [pcmData];
    This.recSize = pcmData.length;
    This.srcSampleRate = pcmSampleRate;
    return This;
  },
  envStart: function(mockEnv, sampleRate) {
    //和平台环境无关的start调用
    var This = this,
      set = This.set;
    This.isMock = mockEnv ? 1 : 0; //非H5环境需要启用mock
    This.buffers = []; //数据缓冲
    This.recSize = 0; //数据大小

    This.envInLast = 0; //envIn接收到最后录音内容的时间
    This.envInFirst = 0; //envIn接收到的首个录音内容的录制时间
    This.envInFix = 0; //补偿的总时间
    This.envInFixTs = []; //补偿计数列表

    set.sampleRate = Math.min(sampleRate, set.sampleRate); //engineCtx需要提前确定最终的采样率
    This.srcSampleRate = sampleRate;

    This.engineCtx = 0;
    //此类型有边录边转码(Worker)支持
    if (This[set.type + "_start"]) {
      var engineCtx = (This.engineCtx = This[set.type + "_start"](set));
      if (engineCtx) {
        engineCtx.pcmDatas = [];
        engineCtx.pcmSize = 0;
      }
    }
  },
  envResume: function() {
    //和平台环境无关的恢复录音
    //重新开始计数
    this.envInFixTs = [];
  },
  envIn: function(pcm, sum) {
    //和平台环境无关的pcm[Int16]输入
    var This = this,
      set = This.set,
      engineCtx = This.engineCtx;
    var size = pcm.length;
    This.recSize += size;

    var buffers = This.buffers;
    buffers.push(pcm);

    /*计算音量 https://blog.csdn.net/jody1989/article/details/73480259
		更高灵敏度算法:
			限定最大感应值10000
				线性曲线：低音量不友好
					power/10000*100 
				对数曲线：低音量友好，但需限定最低感应值
					(1+Math.log10(power/10000))*100
		*/
    var power = sum / size;
    var powerLevel;
    if (power < 1251) {
      //1250的结果10%，更小的音量采用线性取值
      powerLevel = Math.round((power / 1250) * 10);
    } else {
      powerLevel = Math.round(
        Math.min(
          100,
          Math.max(0, (1 + Math.log(power / 10000) / Math.log(10)) * 100)
        )
      );
    }

    var bufferSampleRate = This.srcSampleRate;
    var bufferSize = This.recSize;

    //卡顿丢失补偿：因为设备很卡的时候导致H5接收到的数据量不够造成播放时候变速，结果比实际的时长要短，此处保证了不会变短，但不能修复丢失的音频数据造成音质变差。当前算法采用输入时间侦测下一帧是否需要添加补偿帧，需要(6次输入||超过1秒)以上才会开始侦测，如果滑动窗口内丢失超过1/3就会进行补偿
    var now = Date.now();
    var pcmTime = Math.round((size / bufferSampleRate) * 1000);
    This.envInLast = now;
    if (This.buffers.length == 1) {
      //记下首个录音数据的录制时间
      This.envInFirst = now - pcmTime;
    }
    var envInFixTs = This.envInFixTs;
    envInFixTs.splice(0, 0, { t: now, d: pcmTime });
    //保留3秒的计数滑动窗口
    var tsInStart = now,
      tsPcm = 0;
    for (var i = 0; i < envInFixTs.length; i++) {
      var o = envInFixTs[i];
      if (now - o.t > 3000) {
        envInFixTs.length = i;
        break;
      }
      tsInStart = o.t;
      tsPcm += o.d;
    }
    //达到需要的数据量，开始侦测是否需要补偿
    var tsInPrev = envInFixTs[1];
    var tsIn = now - tsInStart;
    var lost = tsIn - tsPcm;
    if (
      lost > tsIn / 3 &&
      ((tsInPrev && tsIn > 1000) || envInFixTs.length >= 6)
    ) {
      //丢失过多，开始执行补偿
      var addTime = now - tsInPrev.t - pcmTime; //距离上次输入丢失这么多ms
      if (addTime > pcmTime / 5) {
        //丢失超过本帧的1/5
        var fixOpen = !set.disableEnvInFix;
        console.warn(
          "[" + now + "]" + (fixOpen ? "" : "未") + "补偿" + addTime + "ms"
        );
        This.envInFix += addTime;

        //用静默进行补偿
        if (fixOpen) {
          var addPcm = new Int16Array((addTime * bufferSampleRate) / 1000);
          This.recSize += addPcm.length;
          buffers.push(addPcm);
        }
      }
    }

    //此类型有边录边转码(Worker)支持，开启实时转码
    if (engineCtx) {
      //转换成set的采样率
      var chunkInfo = Recorder.SampleData(
        buffers,
        bufferSampleRate,
        set.sampleRate,
        engineCtx.chunkInfo
      );
      engineCtx.chunkInfo = chunkInfo;

      engineCtx.pcmSize += chunkInfo.data.length;
      bufferSize = engineCtx.pcmSize;
      buffers = engineCtx.pcmDatas;
      buffers.push(chunkInfo.data);
      bufferSampleRate = chunkInfo.sampleRate;

      //推入后台转码
      This[set.type + "_encode"](engineCtx, chunkInfo.data);
    }

    var duration = Math.round((bufferSize / bufferSampleRate) * 1000);

    set.onProcess(buffers, powerLevel, duration, bufferSampleRate);
  },

  //开始录音，需先调用open；只要open成功时，调用此方法是安全的，如果未open强行调用导致的内部错误将不会有任何提示，stop时自然能得到错误
  start: function() {
    if (!Recorder.IsOpen()) {
      console.error("未open");
      return;
    }
    console.log("[" + Date.now() + "]Start");

    var This = this,
      set = This.set,
      ctx = Recorder.Ctx;
    This._stop();
    This.state = 0;
    This.envStart(0, ctx.sampleRate);

    //检查open过程中stop是否已经调用过
    if (This._SO && This._SO + 1 != This._S) {
      //上面调用过一次 _stop
      //open未完成就调用了stop，此种情况终止start。也应尽量避免出现此情况
      console.warn("start被中断");
      return;
    }
    This._SO = 0;

    var end = function() {
      This.state = 1;
      This.resume();
    };
    if (ctx.state == "suspended") {
      ctx.resume().then(function() {
        console.log("ctx resume");
        end();
      });
    } else {
      end();
    }
  },
  /*暂停录音*/
  pause: function() {
    var This = this;
    if (This.state) {
      This.state = 2;
      delete Recorder.Stream._call[This.id];
    }
  },
  /*恢复录音*/
  resume: function() {
    var This = this;
    if (This.state) {
      This.state = 1;
      This.envResume();

      Recorder.Stream._call[This.id] = function(pcm, sum) {
        if (This.state == 1) {
          This.envIn(pcm, sum);
        }
      };
    }
  },

  _stop: function(keepEngine) {
    var This = this,
      set = This.set;
    if (!This.isMock) {
      This._S++;
    }
    if (This.state) {
      This.pause();
      This.state = 0;
    }
    if (!keepEngine && This[set.type + "_stop"]) {
      This[set.type + "_stop"](This.engineCtx);
      This.engineCtx = 0;
    }
  },
  /*
	结束录音并返回录音数据blob对象
		True(blob,duration) blob：录音数据audio/mp3|wav格式
							duration：录音时长，单位毫秒
		False(msg)
		autoClose:false 可选，是否自动调用close，默认为false
	*/
  stop: function(True, False, autoClose) {
    var This = this,
      set = This.set,
      t1;
    console.log(
      "[" +
        Date.now() +
        "]Stop " +
        (This.envInLast
          ? This.envInLast - This.envInFirst + "ms 补" + This.envInFix + "ms"
          : "-")
    );

    var end = function() {
      This._stop(); //彻底关掉engineCtx
      if (autoClose) {
        This.close();
      }
    };
    var err = function(msg) {
      False && False(msg);
      end();
    };
    var ok = function(blob, duration) {
      console.log(
        "[" +
          Date.now() +
          "]结束 编码" +
          (Date.now() - t1) +
          "ms 音频" +
          duration +
          "ms/" +
          blob.size +
          "b"
      );
      if (blob.size < Math.max(100, duration / 2)) {
        //1秒小于0.5k？
        err("生成的" + set.type + "无效");
        return;
      }
      True && True(blob, duration);
      end();
    };
    if (!This.isMock) {
      if (!This.state) {
        err("未开始录音");
        return;
      }
      This._stop(true);
    }
    var size = This.recSize;
    if (!size) {
      err("未采集到录音");
      return;
    }
    if (!This.buffers[0]) {
      err("音频被释放");
      return;
    }
    if (!This[set.type]) {
      err("未加载" + set.type + "编码器");
      return;
    }

    //此类型有边录边转码(Worker)支持
    var engineCtx = This.engineCtx;
    if (This[set.type + "_complete"] && engineCtx) {
      var pcmDatas = engineCtx.pcmDatas;
      var duration = Math.round((engineCtx.pcmSize / set.sampleRate) * 1000); //采用后的数据长度和buffers的长度可能微小的不一致，是采样率连续转换的精度问题

      t1 = Date.now();
      This[set.type + "_complete"](
        engineCtx,
        function(blob) {
          ok(blob, duration);
        },
        err
      );
      return;
    }

    //标准UI线程转码，调整采样率
    t1 = Date.now();
    var chunk = Recorder.SampleData(
      This.buffers,
      This.srcSampleRate,
      set.sampleRate
    );

    set.sampleRate = chunk.sampleRate;
    var res = chunk.data;
    var duration = Math.round((res.length / set.sampleRate) * 1000);

    console.log(
      "采样" + size + "->" + res.length + " 花:" + (Date.now() - t1) + "ms"
    );

    setTimeout(function() {
      t1 = Date.now();
      This[set.type](
        res,
        function(blob) {
          ok(blob, duration);
        },
        function(msg) {
          err(msg);
        }
      );
    });
  }
};

if (window.Recorder) {
  window.Recorder.Destroy();
}

//end ****copy源码结束*****
Recorder.LM = LM;

//流量统计用1像素图片地址，设置为空将不参与统计

export default Recorder;
