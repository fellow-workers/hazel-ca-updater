/**
 * Vercel Web Analytics middleware for Express
 * Injects the Vercel Analytics tracking script into HTML responses
 */

function createAnalyticsMiddleware() {
  // Script to inject into HTML responses
  const analyticsScript = `
<script>
  window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); };
</script>
<script defer src="/_vercel/insights/script.js"></script>`;

  return (req, res, next) => {
    // Store the original send function
    const originalSend = res.send;

    // Override the send function
    res.send = function(data) {
      // Check if the response is HTML
      const contentType = res.get('content-type') || '';
      
      if (contentType.includes('text/html') && typeof data === 'string') {
        // Inject analytics script before closing body tag
        if (data.includes('</body>')) {
          data = data.replace('</body>', `${analyticsScript}\n</body>`);
        } else if (data.includes('</html>')) {
          // Fallback: inject before closing html tag if no body tag
          data = data.replace('</html>', `${analyticsScript}\n</html>`);
        }
      }

      // Call original send function with potentially modified data
      return originalSend.call(this, data);
    };

    next();
  };
}

module.exports = {
  createAnalyticsMiddleware
};
