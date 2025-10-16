console.log('=== INTAKE DATA ===');
const intake = JSON.parse(localStorage.getItem('intake') || '{}');
console.log('Full intake object:', intake);
console.log('AlternateExecutors:', intake.AlternateExecutors);
console.log('AlternateExecutor1:', intake.AlternateExecutor1);
console.log('AlternateExecutor2:', intake.AlternateExecutor2);
console.log('AlternateExecutor3:', intake.AlternateExecutor3);
console.log('=== ALL EXECUTOR FIELDS ===');
Object.keys(intake).filter(k => k.toLowerCase().includes('executor')).forEach(k => {
  console.log(k + ':', intake[k]);
});
