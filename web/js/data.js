/* 只读数据加载：共享页面内的请求，失败后允许重新加载。 */
(function (global) {
  'use strict';

  var requests = Object.create(null);

  function load(url) {
    if (requests[url]) return requests[url];
    requests[url] = fetch(url).then(function (response) {
      if (!response.ok) throw new Error(url + ' 返回 HTTP ' + response.status);
      return response.json();
    }).catch(function (err) {
      delete requests[url];
      throw err;
    });
    return requests[url];
  }

  global.MusicData = { load: load };
})(window);
