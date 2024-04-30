export default defineEventHandler(({ context }) => {
    
    console.log('hi from the server')
  
    return {
        hello: 'world'
      }
  });