self.addEventListener('push',(event)=>{
  let data={};
  try{data=event.data?event.data.json():{};}catch{data={body:event.data?event.data.text():'Solar alert'};}
  const title=data.title||'Raja Fraz Solar Alert';
  const options={
    body:data.body||'Solar dashboard alert',
    icon:'/assets/raja-fraz-logo.jpeg',
    badge:'/assets/raja-fraz-logo.jpeg',
    tag:data.tag||'raja-fraz-solar',
    renotify:true,
    data:{url:data.url||'/?view=notifications'},
    actions:[{action:'open',title:'Open Dashboard'}]
  };
  event.waitUntil(self.registration.showNotification(title,options));
});
self.addEventListener('notificationclick',(event)=>{
  event.notification.close();
  const url=event.notification?.data?.url||'/?view=notifications';
  event.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then((windows)=>{
    for(const client of windows){
      if('focus'in client){client.navigate?.(url).catch?.(()=>{});return client.focus();}
    }
    return clients.openWindow?clients.openWindow(url):undefined;
  }));
});
